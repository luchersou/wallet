import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';

/** Payload that violates the transaction contract (400). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

/** Same identity (key or messageId), different payload (409 / DLQ). */
export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IdempotencyConflict;

  constructor(
    readonly idempotencyKey: string,
    reason = 'was already used with a different payload',
  ) {
    super(`Idempotency key "${idempotencyKey}" ${reason}`);
  }
}

/** Programming error: transition from a terminal or disallowed state. */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

export class TransactionNotFoundError extends DomainError {
  readonly code = FailureCode.TransactionNotFound;

  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}