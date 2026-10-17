import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { Money } from '../../src/shared/domain/money';
import { evaluateReference } from '../../src/modules/wagering/domain/reference-policy';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry-policy';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction-kind';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-15T12:00:00Z');
const HASH = 'a'.repeat(64);
const ok = { alreadyReversed: false };

let seq = 0;
const make = (o: Partial<CreateWagerTransactionProps> = {}) => {
  seq++;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    at,
    ...o,
  });
};

const processedRef = (o: Partial<CreateWagerTransactionProps> = {}) => {
  const tx = make(o);
  tx.markProcessed(tx.requiresReference() ? 'some-ref' : undefined, brl('100.00'), at);
  return tx;
};

const refund = (o: Partial<CreateWagerTransactionProps> = {}) =>
  make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-ref', ...o });
const rollback = (o: Partial<CreateWagerTransactionProps> = {}) =>
  make({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-ref', ...o });

describe('evaluateReference', () => {
  it('accepts transactions without reference', () => {
    expect(evaluateReference(make(), undefined, ok)).toEqual({ outcome: 'accept' });
  });

  it('waits when the reference has not arrived', () => {
    expect(evaluateReference(refund(), undefined, ok)).toEqual({ outcome: 'wait' });
  });

  it('accepts REFUND of a processed BET with same amount', () => {
    expect(evaluateReference(refund(), processedRef(), ok)).toEqual({ outcome: 'accept' });
  });

  it('accepts ROLLBACK of BET, WIN and REFUND', () => {
    expect(evaluateReference(rollback(), processedRef(), ok).outcome).toBe('accept');
    expect(evaluateReference(rollback(), processedRef({ kind: Kind.Win }), ok).outcome).toBe('accept');
    expect(
      evaluateReference(
        rollback(),
        processedRef({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-x' }),
        ok,
      ).outcome,
    ).toBe('accept');
  });

  it('accepts WIN referencing a processed BET', () => {
    const win = make({ kind: Kind.Win, referenceExternalTransactionId: 'ext-ref', money: brl('50.00') });
    expect(evaluateReference(win, processedRef(), ok)).toEqual({ outcome: 'accept' });
  });

  it.each([
    ['REFUND of WIN', () => refund(), () => processedRef({ kind: Kind.Win })],
    ['ROLLBACK of LOSS', () => rollback(), () => processedRef({ kind: Kind.Loss })],
    ['WIN of WIN', () => make({ kind: Kind.Win, referenceExternalTransactionId: 'x' }), () => processedRef({ kind: Kind.Win })],
  ])('rejects %s with REFERENCE_KIND_NOT_ALLOWED', (_, tx, ref) => {
    expect(evaluateReference(tx(), ref(), ok)).toEqual({
      outcome: 'reject',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  it.each([
    ['round', { roundId: 'round-2' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['provider', { providerId: 'provider-b' }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
  ])('rejects a reference from a different %s with REFERENCE_MISMATCH', (_, override) => {
    expect(evaluateReference(refund(), processedRef(override), ok)).toEqual({
      outcome: 'reject',
      code: FailureCode.ReferenceMismatch,
    });
  });

  it('waits when the reference itself is still pending', () => {
    const pendingRefund = make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-z' });
    pendingRefund.markPendingReference(at, ReferenceRetryPolicy.default());
    expect(evaluateReference(rollback(), pendingRefund, ok)).toEqual({ outcome: 'wait' });
  });

  it('rejects a reference that was rejected with REFERENCE_NOT_PROCESSED', () => {
    const rejectedBet = make();
    rejectedBet.reject(FailureCode.InsufficientFunds, brl('0.00'), at);
    expect(evaluateReference(refund(), rejectedBet, ok)).toEqual({
      outcome: 'reject',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  it('rejects partial reversal with REVERSAL_AMOUNT_MISMATCH', () => {
    expect(evaluateReference(refund({ money: brl('10.00') }), processedRef(), ok)).toEqual({
      outcome: 'reject',
      code: FailureCode.ReversalAmountMismatch,
    });
  });

  it('rejects a second reversal of the same reference with REFERENCE_ALREADY_REVERSED', () => {
    expect(evaluateReference(refund(), processedRef(), { alreadyReversed: true })).toEqual({
      outcome: 'reject',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });
});