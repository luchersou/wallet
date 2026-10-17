import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import type { Money } from '../../../shared/domain/money';

export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;

  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Wallet ${walletId} has ${balance.toString()}, cannot debit ${requested.toString()}`);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WalletNotFound;

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = FailureCode.WalletAlreadyExists;

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class WalletPlayerMismatchError extends DomainError {
  readonly code = FailureCode.WalletPlayerMismatch;

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not belong to the given player`);
  }
}