import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as PgMikroORM } from '@mikro-orm/postgresql';
import { assertGlobalLedgerInvariant } from '../helpers/invariants';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { TransientInfrastructureError } from '../../src/shared/application/errors';
import { NoopMetrics } from '../../src/shared/application/ports/metrics.port';
import { SQS_CONFIG, type SqsConfig } from '../../src/shared/infrastructure/sqs/sqs.module';
import { PublishOutbox } from '../../src/modules/messaging/application/publish-outbox.use-case';
import type { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import {
  readConsumerOptions,
  WagerTransactionConsumer,
} from '../../src/modules/wagering/infrastructure/messaging/wager-transaction.consumer';
import { PendingReferenceWorker } from '../../src/modules/wagering/infrastructure/scheduling/pending-reference.worker';
import { WorkerModule } from '../../src/worker.module';
import { buildServices, countLedger, type Services } from '../helpers/services';

const uuid = () => Bun.randomUUIDv7();

let app: INestApplicationContext;
let sqs: SQSClient;
let config: SqsConfig;
let s: Services;
const urls = { main: '', dlq: '', events: '' };

beforeAll(async () => {
  process.env.WORKER_AUTOSTART = 'false';
  process.env.SQS_WAIT_TIME_SECONDS = '1';
  process.env.SQS_RETRY_BASE_SECONDS = '0';

  app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  sqs = app.get(SQSClient);
  config = app.get<SqsConfig>(SQS_CONFIG);
  s = buildServices(app.get(MikroORM) as unknown as PgMikroORM);

  const url = async (name: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  urls.main = await url(config.wagerQueue);
  urls.dlq = await url(config.wagerDlq);
  urls.events = await url(config.eventsQueue);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await s.orm.em.getConnection().execute(
    `truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade`,
  );
  for (const q of Object.values(urls)) await sqs.send(new PurgeQueueCommand({ QueueUrl: q }));
});

afterEach(async () => {
  await assertGlobalLedgerInvariant(s.orm as unknown as MikroORM);
});

async function openWallet(amount: string) {
  const playerId = uuid();
  const view = await s.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: uuid() });
  return { walletId: view.id, playerId };
}

function envelope(w: { walletId: string; playerId: string }, kind: string, amount: string, extra: object = {}) {
  const externalTransactionId = `tx-${uuid()}`;
  return {
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

async function send(body: string, groupId: string, dedupId = uuid()) {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: urls.main, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }),
  );
}

async function queueDepth(url: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

async function receive(url: string) {
  const res = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
  );
  return res.Messages ?? [];
}

async function pollUntilDrained(consumer: WagerTransactionConsumer, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts && (await queueDepth(urls.main)) > 0; i++) await consumer.pollOnce();
}

describe('SQS consumer', () => {
  it('processes a message through the same use case and acks after commit', async () => {
    const w = await openWallet('100.00');
    const msg = envelope(w, 'BET', '25.00');
    await send(JSON.stringify(msg), w.walletId);

    await pollUntilDrained(app.get(WagerTransactionConsumer));

    const tx = await s.runner.run(() => s.txs.findByIdempotencyKey('provider-a', msg.data.idempotencyKey));
    expect(tx?.status).toBe(Status.Processed);
    expect(tx?.observedBalance?.amount).toBe('75.00');
    expect(await queueDepth(urls.main)).toBe(0);
  });

  it('deduplicates redelivery of the same messageId through the inbox', async () => {
    const w = await openWallet('100.00');
    const body = JSON.stringify(envelope(w, 'BET', '10.00'));
    await send(body, w.walletId); // different dedup ids: SQS delivers both
    await send(body, w.walletId);

    await pollUntilDrained(app.get(WagerTransactionConsumer));

    expect(await queueDepth(urls.main)).toBe(0);
    expect(await countLedger(s, w.walletId)).toBe(2); // opening + 1 debit
  });

  it('acks business rejections (terminal) without DLQ', async () => {
    const w = await openWallet('10.00');
    await send(JSON.stringify(envelope(w, 'BET', '50.00')), w.walletId);
    await pollUntilDrained(app.get(WagerTransactionConsumer));
    expect(await queueDepth(urls.main)).toBe(0);
    expect(await queueDepth(urls.dlq)).toBe(0);
  });

  it('sends malformed messages straight to the DLQ', async () => {
    await send('not json at all', 'group-x');
    await app.get(WagerTransactionConsumer).pollOnce();

    const dead = await receive(urls.dlq);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_MESSAGE');
    expect(await queueDepth(urls.main)).toBe(0);
  });

  it('sends permanent contract errors to the DLQ', async () => {
    const w = await openWallet('10.00');
    await send(JSON.stringify(envelope({ ...w, walletId: uuid() }, 'BET', '1.00')), w.walletId);
    await app.get(WagerTransactionConsumer).pollOnce();

    const dead = await receive(urls.dlq);
    expect(dead[0]?.MessageAttributes?.failureReason?.StringValue).toBe('WALLET_NOT_FOUND');
  });

  it('retries transient failures and dead-letters after the attempt limit', async () => {
    const failing = {
      execute: async () => {
        throw new TransientInfrastructureError('database unavailable', null);
      },
    } as unknown as ProcessWagerTransaction;

    const consumer = new WagerTransactionConsumer(
      sqs,
      config,
      { ...readConsumerOptions(), waitTimeSeconds: 1, retryBaseSeconds: 0, maxReceiveCount: 2 },
      failing,
      new NoopMetrics(),
    );

    const w = await openWallet('10.00');
    await send(JSON.stringify(envelope(w, 'BET', '1.00')), w.walletId);

    await consumer.pollOnce(); // 1st attempt: retry (visibility 0)
    expect(await queueDepth(urls.dlq)).toBe(0);
    await consumer.pollOnce(); // 2nd attempt: hits the limit → DLQ

    const dead = await receive(urls.dlq);
    expect(dead[0]?.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
    expect(await queueDepth(urls.main)).toBe(0);
  });

  it('keeps group order: after a retry, later messages of the group are not processed', async () => {
    const w = await openWallet('10.00');
    const first = envelope(w, 'BET', '1.00');
    const second = envelope(w, 'BET', '2.00');

    const seen: string[] = [];
    const failsFirst = {
      execute: async (cmd: { externalTransactionId: string }) => {
        seen.push(cmd.externalTransactionId);
        if (cmd.externalTransactionId === first.data.externalTransactionId) {
          throw new TransientInfrastructureError('database unavailable', null);
        }
        return { transactionId: uuid(), status: Status.Processed, balance: { amount: '0.00', currency: 'BRL' }, idempotentReplay: false };
      },
    } as unknown as ProcessWagerTransaction;

    const consumer = new WagerTransactionConsumer(
      sqs,
      config,
      { ...readConsumerOptions(), waitTimeSeconds: 1, retryBaseSeconds: 30 },
      failsFirst,
      new NoopMetrics(),
    );

    await send(JSON.stringify(first), w.walletId);
    await send(JSON.stringify(second), w.walletId);

    expect(await consumer.pollOnce()).toBe(2); // both arrived in the same batch
    expect(seen).toEqual([first.data.externalTransactionId]); // the second one was not processed
    expect(await queueDepth(urls.main)).toBe(2); // none was deleted
  });
});

describe('outbox publisher', () => {
  it('publishes pending events once, keyed by eventId', async () => {
    await openWallet('100.00'); // produces 2 events in the outbox

    const publisher = app.get(PublishOutbox);
    expect(await publisher.publishBatch(25)).toBe(2);
    expect(await publisher.publishBatch(25)).toBe(0);
    expect((await publisher.observeLag()).pending).toBe(0);

    const published = await receive(urls.events);
    expect(published).toHaveLength(2);
    const types = published.map((m) => m.MessageAttributes?.eventType?.StringValue).sort();
    expect(types).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(JSON.parse(published[0]!.Body!).eventId).toBeString();
  });

  it('publishes large backlogs in SQS batches across multiple claims', async () => {
    await Promise.all(Array.from({ length: 60 }, () => openWallet('10.00'))); // 120 events

    const publisher = app.get(PublishOutbox);
    expect(await publisher.publishBatch(100)).toBe(100);
    expect(await publisher.publishBatch(100)).toBe(20);
    expect((await publisher.observeLag()).pending).toBe(0);
  });
});

describe('pending reference worker', () => {
  it('resolves a REFUND once its BET arrives', async () => {
    const w = await openWallet('100.00');
    const betExternalId = `bet-${uuid()}`;

    const refund = await s.processWager.execute({
      ...envelope(w, 'REFUND', '30.00', { referenceExternalTransactionId: betExternalId }).data,
      correlationId: uuid(),
      source: { type: 'http' },
    });
    expect(refund.status).toBe(Status.PendingReference);

    const betData = envelope(w, 'BET', '30.00').data;
    await s.processWager.execute({
      ...betData,
      externalTransactionId: betExternalId,
      idempotencyKey: `provider-a:${betExternalId}`,
      correlationId: uuid(),
      source: { type: 'http' },
    });

    await Bun.sleep(1_100); // first retry scheduled for +1s (default policy)
    await app.get(PendingReferenceWorker).tick();

    const stored = await s.runner.run(() => s.txs.findById(refund.transactionId));
    expect(stored?.status).toBe(Status.Processed);
  });
});