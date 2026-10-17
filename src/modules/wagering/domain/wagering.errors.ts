import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';

/** Payload que viola o contrato da transação (400). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

/** Mesma identidade (key ou messageId), payload diferente (409 / DLQ). */
export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IdempotencyConflict;

  constructor(
    readonly idempotencyKey: string,
    reason = 'was already used with a different payload',
  ) {
    super(`Idempotency key "${idempotencyKey}" ${reason}`);
  }
}

/** Erro de programação: transição a partir de estado terminal ou não permitido. */
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