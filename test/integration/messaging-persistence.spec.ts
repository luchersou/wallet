import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { assertGlobalLedgerInvariant } from '../helpers/invariants';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { EventContext } from '../../src/shared/domain/integration-event';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/persistence/mikro-orm-transaction-runner';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { WalletBalanceChanged } from '../../src/modules/wagering/domain/events/wallet-balance-changed.event';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { MikroOrmInboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm-outbox.repository';
import { createTestOrm, resetDatabase } from '../helpers/orm/orm';

const uuid = () => Bun.randomUUIDv7();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let orm: MikroORM;
let runner: MikroOrmTransactionRunner;
let inbox: MikroOrmInboxRepository;
let outbox: MikroOrmOutboxRepository;

beforeAll(async () => {
  orm = await createTestOrm();
  runner = new MikroOrmTransactionRunner(orm.em);
  inbox = new MikroOrmInboxRepository(orm.em);
  outbox = new MikroOrmOutboxRepository(orm.em);
});
afterAll(async () => {
  await orm.close(true);
});
beforeEach(async () => {
  await resetDatabase(orm);
});

afterEach(async () => {
  await assertGlobalLedgerInvariant(orm as unknown as CoreMikroORM);
});

function makeOutboxMessage(occurredAt: Date): OutboxMessage {
  const ctx: EventContext = { correlationId: uuid(), occurredAt, nextId: uuid };
  const { wallet } = Wallet.open({
    id: uuid(), playerId: uuid(), initialBalance: brl('10.00'),
    openingTransactionId: uuid(), openingLedgerEntryId: uuid(), at: occurredAt,
  });
  const entry = wallet.credit({ money: brl('1.00'), transactionId: uuid(), ledgerEntryId: uuid(), at: occurredAt });
  return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
}

describe('inbox', () => {
  it('registers a message only once, even concurrently', async () => {
    const messageId = `msg-${uuid()}`;
    const attempts = Array.from({ length: 10 }, () =>
      runner.run(() => {
        const msg = InboxMessage.receive({
          messageId, consumerName: 'wager-consumer', payloadHash: 'a'.repeat(64), receivedAt: new Date(),
        });
        msg.markProcessed(new Date());
        return inbox.tryRegister(msg);
      }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await runner.run(() => inbox.find('wager-consumer', messageId));
    expect(stored?.isProcessed()).toBe(true);
  });

  it('scopes deduplication by consumer', async () => {
    const register = (consumerName: string) =>
      runner.run(() =>
        inbox.tryRegister(
          InboxMessage.receive({ messageId: 'same', consumerName, payloadHash: 'a'.repeat(64), receivedAt: new Date() }),
        ),
      );
    expect(await register('consumer-a')).toBe(true);
    expect(await register('consumer-b')).toBe(true);
    expect(await register('consumer-a')).toBe(false);
  });
});

describe('outbox', () => {
  it('round-trips a message and tracks lag', async () => {
    const past = new Date(Date.now() - 5_000);
    const msg = makeOutboxMessage(past);
    await runner.run(() => outbox.add(msg));

    const stats = await runner.run(() => outbox.stats(new Date()));
    expect(stats.pending).toBe(1);
    expect(stats.oldestPendingAgeMs).toBeGreaterThanOrEqual(4_000);
  });

  it('concurrent claimers get disjoint batches (SKIP LOCKED)', async () => {
    const past = new Date(Date.now() - 1_000);
    await runner.run(async () => {
      for (let i = 0; i < 10; i++) await outbox.add(makeOutboxMessage(past));
    });

    const claim = () =>
      runner.run(async () => {
        const batch = await outbox.claimDue(new Date(), 5);
        await Bun.sleep(300); // hold the locks while the other one tries
        for (const m of batch) {
          m.markPublished(new Date());
          await outbox.save(m);
        }
        return batch.map((m) => m.id);
      });

    const [a, b] = await Promise.all([claim(), claim()]);
    const all = [...a, ...b];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(10);

    const stats = await runner.run(() => outbox.stats(new Date()));
    expect(stats.pending).toBe(0);
  });

  it('does not claim messages scheduled in the future', async () => {
    const msg = makeOutboxMessage(new Date());
    msg.scheduleRetry(new Date(), 'publish failed');
    await runner.run(() => outbox.add(msg));
    const batch = await runner.run(() => outbox.claimDue(new Date(), 10));
    expect(batch).toHaveLength(0);
  });
});