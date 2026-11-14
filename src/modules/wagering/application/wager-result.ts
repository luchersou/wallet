import type { FailureCode } from '../../../shared/domain/failure-code';
import type { Money, MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionStatus } from '../domain/wager-transaction-status';

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

/** Terminal: balance observed at that moment. Pending: current wallet balance. */
export function toWagerResult(
  tx: WagerTransaction,
  currentBalance: Money,
  idempotentReplay: boolean,
): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: (tx.observedBalance ?? currentBalance).toJSON(),
    idempotentReplay,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  };
}