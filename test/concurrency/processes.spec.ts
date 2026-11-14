import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createTestOrm, resetDatabase } from '../helpers/orm/orm';
import { killAll, spawnWorker, waitFor, type WorkerProcess } from '../helpers/processes';
import { assertLedgerInvariant, buildServices, countLedger, type Services } from '../helpers/services';

const uuid = () => Bun.randomUUIDv7();

let orm: MikroORM;
let s: Services;
let sqs: SQSClient;
const urls = { main: '', dlq: '', events: '' };
let workers: WorkerProcess[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  s = buildServices(orm);
  sqs = new SQSClient({
    region: process.env.AWS_REGION!,
    endpoint: process.env.AWS_ENDPOINT!,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
  });
  const url = async (name: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  urls.main = await url(process.env.SQS_WAGER_QUEUE!);
  urls.dlq = await url(process.env.SQS_WAGER_DLQ!);
  urls.events = await url(process.env.SQS_EVENTS_QUEUE!);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
  for (const q of Object.values(urls)) await sqs.send(new PurgeQueueCommand({ QueueUrl: q }));
});

afterEach(async () => {
  await killAll(workers);
  workers = [];
});

// ---------- helpers

async function openWallet(amount: string) {
  const playerId = uuid();
  const view = await s.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: uuid() });
  return { walletId: view.id, playerId };
}

function betMessage(w: { walletId: string; playerId: string }, amount: string) {
  const externalTransactionId = `tx-${uuid()}`;
  return JSON.stringify({
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: `round-${uuid()}`,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  });
}

/** Random groupId per message: forces concurrent delivery to different processes. */
async function sendAll(bodies: string[]): Promise<void> {
  for (let i = 0; i < bodies.length; i += 10) {
    const chunk = bodies.slice(i, i + 10);
    const res = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: urls.main,
        Entries: chunk.map((body, idx) => ({
          Id: String(idx),
          MessageBody: body,
          MessageGroupId: uuid(),
          MessageDeduplicationId: uuid(),
        })),
      }),
    );
    if (res.Failed?.length) throw new Error(`batch send failed: ${JSON.stringify(res.Failed)}`);
  }
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

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const rows = (await orm.em.getConnection().execute(sql, params)) as { n: number }[];
  return rows[0]?.n ?? 0;
}

const betCount = () => scalar(`select count(*)::int as n from wager_transactions where kind = 'BET'`);
const statusCount = (status: string) =>
  scalar(`select count(*)::int as n from wager_transactions where kind = 'BET' and status = ?`, [status]);

/** Global invariant: no wallet with a balance different from the sum of its ledger. */
async function assertAllWalletsConsistent(): Promise<void> {
  const divergent = await scalar(
    `select count(*)::int as n from wallets w
      where w.balance <> coalesce((
        select sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end)
          from wallet_ledger_entries l where l.wallet_id = w.id), 0)`,
  );
  expect(divergent).toBe(0);
  expect(await scalar(`select count(*)::int as n from wallets where balance < 0`)).toBe(0);
}

async function balanceOf(walletId: string): Promise<string> {
  const wallet = await s.runner.run(() => s.wallets.findById(walletId));
  return wallet!.balance.amount;
}

// ---------- scenarios

describe('multiple worker processes', () => {
  it('3 processes on a hot wallet: no lost update, no duplicate debit, no negative balance', async () => {
    const w = await openWallet('1000.00');
    const bets = Array.from({ length: 150 }, () => betMessage(w, '10.00'));

    workers = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    await sendAll([...bets, ...bets]); // each message delivered 2x (at-least-once)

    await waitFor(async () => (await betCount()) === 150 && (await queueDepth(urls.main)) === 0, 90_000, 500);

    expect(await statusCount('PROCESSED')).toBe(100);
    expect(await statusCount('REJECTED')).toBe(50);
    expect(await balanceOf(w.walletId)).toBe('0.00');
    expect(await countLedger(s, w.walletId)).toBe(101); // opening + 100 debits
    expect(await scalar(`select count(*)::int as n from inbox_messages`)).toBe(150);
    expect(await queueDepth(urls.dlq)).toBe(0);
    await assertAllWalletsConsistent();
  }, 120_000);

  it('distinct wallets are processed in parallel across processes', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));
    const bodies = wallets.flatMap((w) => Array.from({ length: 10 }, () => betMessage(w, '5.00')));

    workers = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    await sendAll(bodies);

    await waitFor(async () => (await betCount()) === 100 && (await queueDepth(urls.main)) === 0, 90_000, 500);

    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('50.00');
      await assertLedgerInvariant(s, w.walletId);
    }
    await assertAllWalletsConsistent();
  }, 120_000);

  it('worker killed after commit and before ack: redelivery does not duplicate the debit', async () => {
    const w = await openWallet('100.00');

    const chaos = await spawnWorker({ CHAOS_EXIT_BEFORE_ACK: 'true', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' });
    workers = [chaos];
    await sendAll([betMessage(w, '25.00')]);

    expect(await chaos.proc.exited).toBe(137); // died exactly between commit and ack

    // The commit happened; the message is still in the queue (no ack)
    expect(await balanceOf(w.walletId)).toBe('75.00');
    expect(await countLedger(s, w.walletId)).toBe(2);
    expect(await queueDepth(urls.main)).toBe(1);

    // Another instance takes over: the redelivery hits the inbox and becomes a replay
    workers = [await spawnWorker()];
    await waitFor(async () => (await queueDepth(urls.main)) === 0, 30_000, 500);

    expect(await balanceOf(w.walletId)).toBe('75.00');
    expect(await countLedger(s, w.walletId)).toBe(2);
    expect(await betCount()).toBe(1);
    await assertAllWalletsConsistent();
  }, 60_000);

  it('restart mid-processing (SIGKILL on all instances) converges to a consistent state', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => openWallet('500.00')));
    const bodies = wallets.flatMap((w) => Array.from({ length: 50 }, () => betMessage(w, '5.00')));

    workers = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    await sendAll([...bodies, ...bodies]);

    await waitFor(async () => (await betCount()) > 20, 30_000, 100); // let part of it be processed
    await killAll(workers, 'SIGKILL');

    workers = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    await waitFor(async () => (await betCount()) === 200 && (await queueDepth(urls.main)) === 0, 90_000, 500);

    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('250.00');
      expect(await countLedger(s, w.walletId)).toBe(51);
    }
    await assertAllWalletsConsistent();
  }, 150_000);

  it('concurrent outbox publishers in different processes publish every event exactly once', async () => {
    await Promise.all(Array.from({ length: 40 }, () => openWallet('10.00'))); // 80 events in the outbox
    const expected = await scalar(`select count(*)::int as n from outbox_messages`);
    expect(expected).toBe(80);

    workers = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    await waitFor(async () => (await scalar(`select count(*)::int as n from outbox_messages where published_at is null`)) === 0, 60_000);

    const eventIds: string[] = [];
    let emptyPolls = 0;
    while (emptyPolls < 3) {
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      const messages = res.Messages ?? [];
      if (messages.length === 0) {
        emptyPolls++;
        continue;
      }
      emptyPolls = 0;
      for (const m of messages) {
        eventIds.push(JSON.parse(m.Body!).eventId);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: urls.events, ReceiptHandle: m.ReceiptHandle }));
      }
    }

    expect(new Set(eventIds).size).toBe(80);
    expect(eventIds).toHaveLength(80);
    await assertAllWalletsConsistent();
  }, 120_000);

  // There is no real SIGTERM on Windows (Bun uses TerminateProcess); runs on Linux/macOS and in Docker
  it.skipIf(process.platform === 'win32')(
    'SIGTERM drains in-flight work; nothing is lost after restart',
    async () => {
      const w = await openWallet('1000.00');
      const bodies = Array.from({ length: 60 }, () => betMessage(w, '1.00'));

      const first = await spawnWorker();
      workers = [first];
      await sendAll(bodies);
      await waitFor(async () => (await betCount()) > 5, 30_000, 100);

      first.proc.kill('SIGTERM');
      await Promise.race([
        first.proc.exited,
        Bun.sleep(25_000).then(() => {
          throw new Error('worker did not stop within grace period');
        }),
      ]);

      workers = [await spawnWorker()];
      await waitFor(async () => (await betCount()) === 60 && (await queueDepth(urls.main)) === 0, 60_000, 500);

      expect(await balanceOf(w.walletId)).toBe('940.00');
      await assertAllWalletsConsistent();
    },
    90_000,
  );
});