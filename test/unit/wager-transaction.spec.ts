import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { InvariantViolationError } from '../../src/shared/domain/invariant-violation.error';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/modules/wallet/domain/ledger-direction';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry-policy';
import {
  SYSTEM_PROVIDER_ID,
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../src/modules/wagering/domain/wagering.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-15T12:00:00Z');
const HASH = 'a'.repeat(64);
const policy = new ReferenceRetryPolicy(3, 1_000, 10_000);

const make = (o: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
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

const processed = (o: Partial<CreateWagerTransactionProps> = {}) => {
  const tx = make(o);
  tx.markProcessed(tx.requiresReference() ? 'ref-id' : undefined, brl('100.00'), at);
  return tx;
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('starts PENDING', () => {
      const tx = make();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.affectsBalance()).toBe(true);
      expect(tx.requiresReference()).toBe(false);
      expect(tx.referenceAttempts).toBe(0);
    });

    it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
      expect(() => make({ kind })).toThrow(InvalidWagerTransactionError);
      expect(make({ kind, referenceExternalTransactionId: 'ext-0' }).requiresReference()).toBe(true);
    });

    it.each([Kind.Bet, Kind.Loss])('%s forbids a reference', (kind) => {
      expect(() => make({ kind, referenceExternalTransactionId: 'ext-0' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('WIN accepts an optional reference', () => {
      expect(make({ kind: Kind.Win }).referenceExternalTransactionId).toBeUndefined();
      expect(make({ kind: Kind.Win, referenceExternalTransactionId: 'ext-0' }).referenceExternalTransactionId).toBe('ext-0');
    });

    it('rejects self reference', () => {
      expect(() =>
        make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-1' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejects zero amount except for LOSS', () => {
      expect(() => make({ money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
      const loss = make({ kind: Kind.Loss, money: brl('0.00') });
      expect(loss.affectsBalance()).toBe(false);
    });

    it('reserves OPENING to the system provider', () => {
      expect(() => make({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
      expect(() => make({ providerId: SYSTEM_PROVIDER_ID })).toThrow(InvalidWagerTransactionError);
    });

    it('rejects invalid payload hash and missing fields', () => {
      expect(() => make({ payloadHash: 'abc' })).toThrow(InvalidWagerTransactionError);
      expect(() => make({ roundId: '  ' })).toThrow(InvalidWagerTransactionError);
    });

    it('matches payload by hash', () => {
      const tx = make();
      expect(tx.matchesPayload(HASH)).toBe(true);
      expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
    });
  });

  describe('createOpening', () => {
    it('creates an already processed internal credit', () => {
      const tx = WagerTransaction.createOpening({
        id: 'tx-open', walletId: 'wallet-1', playerId: 'player-1',
        money: brl('1000.00'), payloadHash: HASH, at,
      });
      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.providerId).toBe(SYSTEM_PROVIDER_ID);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.observedBalance?.amount).toBe('1000.00');
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('transitions', () => {
    it('PENDING → PROCESSED records balance and time', () => {
      const tx = make();
      tx.markProcessed(undefined, brl('975.00'), at);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.observedBalance?.amount).toBe('975.00');
      expect(tx.processedAt).toEqual(at);
      expect(tx.isTerminal()).toBe(true);
    });

    it('reversal cannot be processed without resolved reference', () => {
      const tx = make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' });
      expect(() => tx.markProcessed(undefined, brl('1.00'), at)).toThrow(InvariantViolationError);
    });

    it('PENDING → REJECTED keeps failure code and balance', () => {
      const tx = make();
      tx.reject(FailureCode.InsufficientFunds, brl('20.00'), at);
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.observedBalance?.amount).toBe('20.00');
    });

    it('PENDING → FAILED', () => {
      const tx = make();
      tx.fail(FailureCode.PermanentInfrastructureError, at);
      expect(tx.status).toBe(Status.Failed);
      expect(tx.observedBalance).toBeUndefined();
    });

    it('pending reference lifecycle until exhaustion', () => {
      const tx = make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' });
      tx.markPendingReference(at, policy);
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.nextReferenceAttemptAt).toEqual(new Date(at.getTime() + 1_000));

      tx.scheduleReferenceRetry(at, policy);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceAttemptAt).toEqual(new Date(at.getTime() + 2_000));

      tx.scheduleReferenceRetry(at, policy);
      tx.scheduleReferenceRetry(at, policy);
      expect(tx.hasExhaustedReferenceRetries(policy)).toBe(true);

      tx.reject(FailureCode.ReferenceNotFound, brl('100.00'), at);
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it('backoff respects the ceiling', () => {
      expect(policy.delayFor(0)).toBe(1_000);
      expect(policy.delayFor(3)).toBe(8_000);
      expect(policy.delayFor(10)).toBe(10_000);
    });

    it('only transactions with reference can wait for it', () => {
      expect(() => make().markPendingReference(at, policy)).toThrow(InvariantViolationError);
    });

    it('retry scheduling requires PENDING_REFERENCE', () => {
      expect(() => make().scheduleReferenceRetry(at, policy)).toThrow(InvalidTransactionStateError);
    });

    describe('terminal states are final', () => {
      const terminals = {
        PROCESSED: () => processed(),
        REJECTED: () => {
          const tx = make();
          tx.reject(FailureCode.InsufficientFunds, brl('0.00'), at);
          return tx;
        },
        FAILED: () => {
          const tx = make();
          tx.fail(FailureCode.PermanentInfrastructureError, at);
          return tx;
        },
      };

      for (const [name, build] of Object.entries(terminals)) {
        it(`${name} rejects every transition`, () => {
          expect(() => build().markProcessed(undefined, brl('1.00'), at)).toThrow(InvalidTransactionStateError);
          expect(() => build().reject(FailureCode.InsufficientFunds, brl('1.00'), at)).toThrow(InvalidTransactionStateError);
          expect(() => build().fail(FailureCode.PermanentInfrastructureError, at)).toThrow(InvalidTransactionStateError);
          expect(() => build().markPendingReference(at, policy)).toThrow(InvalidTransactionStateError);
        });
      }
    });
  });

  describe('ledgerDirectionFor', () => {
    it('BET debits; WIN and REFUND credit', () => {
      expect(make().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(
        make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }).ledgerDirectionFor(),
      ).toBe(LedgerDirection.Credit);
    });

    it('ROLLBACK inverts its reference', () => {
      const rollback = make({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-0' });
      expect(rollback.ledgerDirectionFor(make({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(make({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
      expect(
        rollback.ledgerDirectionFor(make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-9' })),
      ).toBe(LedgerDirection.Debit);
    });

    it('ROLLBACK without reference and LOSS are programming errors', () => {
      const rollback = make({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-0' });
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
      expect(() => make({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvariantViolationError);
    });
  });

  describe('rehydrate', () => {
    it('restores terminal state without revalidating', () => {
      const original = processed();
      const tx = WagerTransaction.rehydrate({
        id: original.id, providerId: original.providerId,
        externalTransactionId: original.externalTransactionId,
        idempotencyKey: original.idempotencyKey, payloadHash: original.payloadHash,
        walletId: original.walletId, playerId: original.playerId,
        roundId: original.roundId, gameId: original.gameId, kind: original.kind,
        money: original.money, status: Status.Processed,
        observedBalance: brl('100.00'), referenceAttempts: 0,
        createdAt: at, updatedAt: at, processedAt: at,
      });
      expect(tx.isTerminal()).toBe(true);
      expect(tx.observedBalance?.amount).toBe('100.00');
    });
  });
});