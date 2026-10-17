import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';

/**
 * Backoff exponencial para transações PENDING_REFERENCE.
 * Default: até 10 reagendamentos (11 reprocessamentos pelo worker),
 * intervalos de 1s dobrando até o teto de 5min ≈ 18,5 min no total.
 */
export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts: number,
    readonly baseDelayMs: number,
    readonly maxDelayMs: number,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvariantViolationError('maxAttempts must be a positive integer');
    }
    if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs) {
      throw new InvariantViolationError('invalid retry delays');
    }
  }

  static default(): ReferenceRetryPolicy {
    return new ReferenceRetryPolicy(10, 1_000, 300_000);
  }

  delayFor(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayFor(attempt));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}