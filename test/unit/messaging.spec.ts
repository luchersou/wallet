import { describe, expect, it } from 'bun:test';
import type { EventContext } from '../../src/shared/domain/integration-event';
import { Money } from '../../src/shared/domain/money';
import { canonicalJson } from '../../src/shared/infrastructure/crypto/canonical-json';
import { payloadHash } from '../../src/shared/infrastructure/crypto/payload-hash';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { WalletBalanceChanged } from '../../src/modules/wagering/domain/events/wallet-balance-changed.event';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-15T12:00:00.000Z');
let n = 0;
const ctx: EventContext = { correlationId: 'corr-1', occurredAt: at, nextId: () => `evt-${++n}` };

const balanceChanged = () => {
  const { wallet } = Wallet.open({
    id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00'),
    openingTransactionId: 'tx-0', openingLedgerEntryId: 'e-0', at,
  });
  const entry = wallet.debit({ money: brl('25.00'), transactionId: 'tx-1', ledgerEntryId: 'e-1', at });
  return WalletBalanceChanged.from(wallet, entry, ctx);
};

describe('canonical json / payload hash', () => {
  it('ignores key order recursively', () => {
    const a = { b: 1, a: { d: 'x', c: 'y' } };
    const b = { a: { c: 'y', d: 'x' }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it('omits undefined and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  it('changes when a business value changes', () => {
    expect(payloadHash({ amount: '25.00' })).not.toBe(payloadHash({ amount: '25.01' }));
    expect(payloadHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('IntegrationEvent', () => {
  it('serializes a stable, versioned envelope with MoneyProps', () => {
    const json = balanceChanged().toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.occurredAt).toBe('2026-10-15T12:00:00.000Z');
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('OutboxMessage', () => {
  it('enqueues an event using eventId as id, due immediately', () => {
    const event = balanceChanged();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.aggregateId).toBe('wallet-1');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at)).toBe(true);
    expect(msg.payload.eventType).toBe('WalletBalanceChanged');
  });

  it('backs off exponentially up to the ceiling', () => {
    const msg = OutboxMessage.enqueue(balanceChanged());
    msg.scheduleRetry(at, 'boom');
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt.getTime() - at.getTime()).toBe(1_000);
    expect(msg.isDue(at)).toBe(false);
    msg.scheduleRetry(at);
    expect(msg.nextAttemptAt.getTime() - at.getTime()).toBe(2_000);
    for (let i = 0; i < 10; i++) msg.scheduleRetry(at);
    expect(msg.nextAttemptAt.getTime() - at.getTime()).toBe(60_000);
  });

  it('cannot be published twice', () => {
    const msg = OutboxMessage.enqueue(balanceChanged());
    msg.markPublished(at);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(at)).toThrow();
    expect(() => msg.scheduleRetry(at)).toThrow();
  });
});

describe('InboxMessage', () => {
  it('is processed only once', () => {
    const msg = InboxMessage.receive({
      messageId: 'm-1', consumerName: 'c', payloadHash: 'a'.repeat(64), receivedAt: at,
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(at)).toThrow();
  });
});