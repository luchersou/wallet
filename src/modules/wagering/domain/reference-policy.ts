import { FailureCode } from '../../../shared/domain/failure-code';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';
import type { WagerTransaction } from './wager-transaction';

export type ReferenceEvaluation =
  | { outcome: 'accept' }
  | { outcome: 'wait' }
  | { outcome: 'reject'; code: FailureCode };

const ALLOWED_REFERENCE_KINDS: Partial<Record<Kind, readonly Kind[]>> = {
  [Kind.Win]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

export interface ReferenceContext {
  /** Is there already a PROCESSED reversal pointing to the reference? (looked up by the use case) */
  alreadyReversed: boolean;
}

/**
 * Section 7 rules, without I/O. The reference is looked up by
 * (providerId, referenceExternalTransactionId) before calling this function.
 */
export function evaluateReference(
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  context: ReferenceContext,
): ReferenceEvaluation {
  if (!tx.referenceExternalTransactionId) return { outcome: 'accept' };
  if (!reference) return { outcome: 'wait' };

  const sameScope =
    reference.id !== tx.id &&
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameScope) return { outcome: 'reject', code: FailureCode.ReferenceMismatch };

  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(reference.kind)) {
    return { outcome: 'reject', code: FailureCode.ReferenceKindNotAllowed };
  }

  if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
    return { outcome: 'wait' };
  }
  if (reference.status !== Status.Processed) {
    return { outcome: 'reject', code: FailureCode.ReferenceNotProcessed };
  }

  if (tx.isReversal()) {
    if (!reference.money.equals(tx.money)) {
      return { outcome: 'reject', code: FailureCode.ReversalAmountMismatch };
    }
    if (context.alreadyReversed) {
      return { outcome: 'reject', code: FailureCode.ReferenceAlreadyReversed };
    }
  }

  return { outcome: 'accept' };
}