import type { MoneyProps } from '../../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';
import type { WagerTransactionKind } from '../wager-transaction-kind';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function wagerEventData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}