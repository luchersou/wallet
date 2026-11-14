import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { assertGlobalLedgerInvariant } from '../helpers/invariants';
import type { MikroORM } from '@mikro-orm/postgresql';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { CurrencyMismatchError } from '../../src/shared/domain/money.errors';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../src/modules/wallet/domain/wallet.errors';
import type { SubmitWagerCommand } from '../../src/modules/wagering/application/submit-wager.command';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import {
  IdempotencyConflictError,
  InvalidWagerTransactionError,
} from '../../src/modules/wagering/domain/wagering.errors';
import { createTestOrm, resetDatabase } from '../helpers/orm/orm';
import { assertLedgerInvariant, buildServices, countLedger, countOutbox, type Services } from '../helpers/services';

const uuid = () => Bun.randomUUIDv7();

let orm: MikroORM;
let s: Services;

beforeAll(async () => {
  orm = await createTestOrm();
  s = buildServices(orm);
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

async function openWallet(amount: string) {
  const playerId = uuid();
  const view = await s.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: uuid(),
  });
  return { walletId: view.id, playerId };
}

let ext = 0;
function wager(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const externalTransactionId = extra.externalTransactionId ?? `tx-${++ext}-${uuid()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    correlationId: uuid(),
    source: { type: 'http' },
    ...extra,
  };
}

describe('OpenWallet', () => {
  it('opens a wallet with OPENING transaction, ledger and events atomically', async () => {
    const w = await openWallet('1000.00');
    expect(await countLedger(s, w.walletId)).toBe(1);
    expect(await countOutbox(s, 'WalletBalanceChanged')).toBe(1);
    expect(await countOutbox(s, 'WagerTransactionProcessed')).toBe(1);
    await assertLedgerInvariant(s, w.walletId);
  });

  it('rejects a duplicate wallet for the same player and currency', async () => {
    const w = await openWallet('10.00');
    await expect(
      s.openWallet.execute({ playerId: w.playerId, initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId: uuid() }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });
});

describe('ProcessWagerTransaction', () => {
  it('processes a BET and replays it with the original balance', async () => {
    const w = await openWallet('1000.00');
    const bet = wager(w, 'BET', '25.00');

    const first = await s.processWager.execute(bet);
    expect(first.status).toBe(Status.Processed);
    expect(first.balance.amount).toBe('975.00');
    expect(first.idempotentReplay).toBe(false);

    await s.processWager.execute(wager(w, 'BET', '100.00')); // changes the balance afterwards

    const replay = await s.processWager.execute({ ...bet, correlationId: uuid() });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.amount).toBe('975.00'); // balance observed at that moment
    await assertLedgerInvariant(s, w.walletId);
  });

  it('treats the same key with a different payload as conflict', async () => {
    const w = await openWallet('1000.00');
    const bet = wager(w, 'BET', '25.00');
    await s.processWager.execute(bet);
    await expect(
      s.processWager.execute({ ...bet, money: { amount: '26.00', currency: 'BRL' } }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('section 8: two concurrent 80.00 bets on 100.00 → one processed, one rejected', async () => {
    const w = await openWallet('100.00');
    const results = await Promise.all([
      s.processWager.execute(wager(w, 'BET', '80.00')),
      s.processWager.execute(wager(w, 'BET', '80.00')),
    ]);

    const processed = results.filter((r) => r.status === Status.Processed);
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.failureCode).toBe(FailureCode.InsufficientFunds);

    const wallet = await s.runner.run(() => s.wallets.findById(w.walletId));
    expect(wallet?.balance.amount).toBe('20.00');
    expect(await countLedger(s, w.walletId)).toBe(2); // opening + 1 debit
    await assertLedgerInvariant(s, w.walletId);
  });

  it('the same bet sent 50 times in parallel debits once', async () => {
    const w = await openWallet('1000.00');
    const bet = wager(w, 'BET', '10.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => s.processWager.execute({ ...bet, correlationId: uuid() })),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.balance.amount === '990.00')).toBe(true);
    expect(await countLedger(s, w.walletId)).toBe(2);
    await assertLedgerInvariant(s, w.walletId);
  });

  it('processes different wallets in parallel', async () => {
    const walletsUnderTest = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));
    const results = await Promise.all(walletsUnderTest.map((w) => s.processWager.execute(wager(w, 'BET', '30.00'))));
    expect(results.every((r) => r.status === Status.Processed && r.balance.amount === '70.00')).toBe(true);
    for (const w of walletsUnderTest) await assertLedgerInvariant(s, w.walletId);
  });

  it('LOSS records the outcome without moving balance or ledger', async () => {
    const w = await openWallet('100.00');
    await s.processWager.execute(wager(w, 'BET', '10.00'));
    const balanceEventsBefore = await countOutbox(s, 'WalletBalanceChanged');

    const loss = await s.processWager.execute(wager(w, 'LOSS', '0.00'));
    expect(loss.status).toBe(Status.Processed);
    expect(loss.balance.amount).toBe('90.00');
    expect(await countLedger(s, w.walletId)).toBe(2);
    expect(await countOutbox(s, 'WalletBalanceChanged')).toBe(balanceEventsBefore);
  });

  it('WIN credits, optionally referencing the BET', async () => {
    const w = await openWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    await s.processWager.execute(bet);
    const win = await s.processWager.execute(
      wager(w, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.status).toBe(Status.Processed);
    expect(win.balance.amount).toBe('140.00');
    await assertLedgerInvariant(s, w.walletId);
  });

  it('REFUND reverses a BET only once', async () => {
    const w = await openWallet('100.00');
    const bet = wager(w, 'BET', '40.00');
    await s.processWager.execute(bet);

    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    const refund = await s.processWager.execute(wager(w, 'REFUND', '40.00', ref));
    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance.amount).toBe('100.00');

    const second = await s.processWager.execute(wager(w, 'REFUND', '40.00', ref));
    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    const rollback = await s.processWager.execute(wager(w, 'ROLLBACK', '40.00', ref));
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await assertLedgerInvariant(s, w.walletId);
  });

  it('rejects ROLLBACK of a WIN that would overdraw, with a distinct code', async () => {
    const w = await openWallet('0.00');
    const win = wager(w, 'WIN', '50.00');
    await s.processWager.execute(win);
    await s.processWager.execute(wager(w, 'BET', '50.00')); // player spent the winnings

    const rollback = await s.processWager.execute(
      wager(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    await assertLedgerInvariant(s, w.walletId);
  });

  it('REFUND before its BET waits, then applies when the BET arrives', async () => {
    const w = await openWallet('100.00');
    const betExternalId = `bet-${uuid()}`;

    const refund = await s.processWager.execute(
      wager(w, 'REFUND', '30.00', { referenceExternalTransactionId: betExternalId }),
    );
    expect(refund.status).toBe(Status.PendingReference);
    expect(await countOutbox(s, 'WagerTransactionPendingReference')).toBe(1);

    await s.processWager.execute(wager(w, 'BET', '30.00', { externalTransactionId: betExternalId }));
    await Bun.sleep(10); // past nextReferenceAttemptAt (test policy: 5ms)

    expect(await s.retryPending.execute(refund.transactionId)).toBe('processed');

    const stored = await s.runner.run(() => s.txs.findById(refund.transactionId));
    expect(stored?.status).toBe(Status.Processed);
    expect(stored?.observedBalance?.amount).toBe('100.00');
    await assertLedgerInvariant(s, w.walletId);
  });

  it('rejects with REFERENCE_NOT_FOUND after exhausting retries', async () => {
    const w = await openWallet('100.00');
    const refund = await s.processWager.execute(
      wager(w, 'REFUND', '30.00', { referenceExternalTransactionId: `never-${uuid()}` }),
    );

    let outcome = 'rescheduled';
    for (let i = 0; i < 10 && outcome !== 'rejected'; i++) {
      await Bun.sleep(25);
      outcome = await s.retryPending.execute(refund.transactionId);
    }
    expect(outcome).toBe('rejected');

    const stored = await s.runner.run(() => s.txs.findById(refund.transactionId));
    expect(stored?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await countOutbox(s, 'WagerTransactionRejected')).toBe(1);
  });

  it('deduplicates SQS redelivery through the inbox', async () => {
    const w = await openWallet('100.00');
    const source = { type: 'sqs' as const, consumerName: 'wager-consumer', messageId: `msg-${uuid()}` };
    const bet = wager(w, 'BET', '10.00', { source });

    const first = await s.processWager.execute(bet);
    const redelivery = await s.processWager.execute(bet);
    expect(redelivery.idempotentReplay).toBe(true);
    expect(redelivery.transactionId).toBe(first.transactionId);
    expect(await countLedger(s, w.walletId)).toBe(2);
  });

  it('rejects contract violations without persisting anything', async () => {
    const w = await openWallet('100.00');
    await expect(s.processWager.execute(wager({ ...w, walletId: uuid() }, 'BET', '10.00'))).rejects.toThrow(
      WalletNotFoundError,
    );
    await expect(
      s.processWager.execute({ ...wager(w, 'BET', '10.00'), money: { amount: '10.00', currency: 'USD' } }),
    ).rejects.toThrow(CurrencyMismatchError);
    await expect(s.processWager.execute(wager(w, 'OPENING', '10.00'))).rejects.toThrow(
      InvalidWagerTransactionError,
    );
    await expect(s.processWager.execute(wager(w, 'BET', '10.5'))).rejects.toThrow();
    expect(await countLedger(s, w.walletId)).toBe(1);
  });

  it('treats a reused messageId with a different payload as conflict, not replay', async () => {
    const w = await openWallet('100.00');
    const source = { type: 'sqs' as const, consumerName: 'wager-consumer', messageId: `msg-${uuid()}` };
    const bet = wager(w, 'BET', '25.00', { source });
    await s.processWager.execute(bet);

    // same messageId and same key, different amount
    await expect(
      s.processWager.execute({ ...bet, money: { amount: '26.00', currency: 'BRL' } }),
    ).rejects.toThrow(IdempotencyConflictError);

    // same messageId, an entirely different transaction
    await expect(s.processWager.execute(wager(w, 'BET', '10.00', { source }))).rejects.toThrow(
      IdempotencyConflictError,
    );

    expect(await countLedger(s, w.walletId)).toBe(2); // opening + only the original debit
    await assertLedgerInvariant(s, w.walletId);
  });
});