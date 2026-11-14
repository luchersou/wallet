import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';

/**
 * Exponential backoff for PENDING_REFERENCE transactions.
 * Default: up to 10 reschedules (11 reprocessings by the worker),
 * intervals starting at 1s, doubling up to a 5min cap ≈ 18.5 min in total.
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