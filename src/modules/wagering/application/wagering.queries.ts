import { Injectable } from '@nestjs/common';
import type { FailureCode } from '../../../shared/domain/failure-code';
import type { MoneyProps } from '../../../shared/domain/money';
import { WagerTransactionRepository } from '../domain/ports/wager-transaction.repository';
import type { WagerTransaction } from '../domain/wager-transaction';
import { TransactionNotFoundError } from '../domain/wagering.errors';

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export const toTransactionView = (tx: WagerTransaction): TransactionView => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
  ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
  ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
  createdAt: tx.createdAt.toISOString(),
  ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
});

@Injectable()
export class WageringQueries {
  constructor(private readonly txs: WagerTransactionRepository) {}

  async getById(transactionId: string): Promise<TransactionView> {
    const tx = await this.txs.findById(transactionId);
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.txs.findByExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    return toTransactionView(tx);
  }
}