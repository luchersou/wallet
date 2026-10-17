import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

export class InvalidMoneyError extends DomainError {
  readonly code = FailureCode.InvalidMoney;

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}