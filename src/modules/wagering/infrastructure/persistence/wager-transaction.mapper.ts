import type { FailureCode } from '../../../../shared/domain/failure-code';
import { toMoney } from '../../../../shared/infrastructure/persistence/money.mapper';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { WagerTransactionRecord } from './wager-transaction.schema';

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: toMoney(r.amount, r.currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
      observedBalance: r.observedBalance ? toMoney(r.observedBalance, r.currency) : undefined,
      referenceAttempts: r.referenceAttempts,
      nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      processedAt: r.processedAt ?? undefined,
    });
  },

  toNewRecord(tx: WagerTransaction): WagerTransactionRecord {
    const record = Object.assign(new WagerTransactionRecord(), {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      currency: tx.money.currency,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      createdAt: tx.createdAt,
    });
    WagerTransactionMapper.apply(tx, record);
    return record;
  },

  /** Só os campos mutáveis — o trigger do banco bloqueia o resto. */
  apply(tx: WagerTransaction, record: WagerTransactionRecord): void {
    record.status = tx.status;
    record.referenceTransactionId = tx.referenceTransactionId ?? null;
    record.failureCode = tx.failureCode ?? null;
    record.observedBalance = tx.observedBalance?.amount ?? null;
    record.referenceAttempts = tx.referenceAttempts;
    record.nextReferenceAttemptAt = tx.nextReferenceAttemptAt ?? null;
    record.updatedAt = tx.updatedAt;
    record.processedAt = tx.processedAt ?? null;
  },
};