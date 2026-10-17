import { Injectable } from '@nestjs/common';
import { Clock } from '../../../shared/application/ports/clock.port';
import { IdGenerator } from '../../../shared/application/ports/id-generator.port';
import { TransactionRunner } from '../../../shared/application/ports/transaction-runner.port';
import { WalletRepository } from '../../wallet/domain/ports/wallet.repository';
import { WagerTransactionRepository } from '../domain/ports/wager-transaction.repository';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { WagerTransactionProcessor } from './wager-transaction-processor';

export type RetryOutcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

@Injectable()
export class RetryPendingReference {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly txs: WagerTransactionRepository,
    private readonly processor: WagerTransactionProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(transactionId: string): Promise<RetryOutcome> {
    // 1ª leitura só para descobrir a wallet — a ordem de lock é sempre wallet primeiro
    const snapshot = await this.runner.run(() => this.txs.findById(transactionId));
    if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) return 'skipped';

    return this.runner.run(async () => {
      const now = this.clock.now();
      const wallet = await this.wallets.findByIdForUpdate(snapshot.walletId);
      const tx = await this.txs.findById(transactionId); // releitura com a wallet travada

      // Outro worker pode ter resolvido ou reagendado no meio-tempo
      if (
        !wallet ||
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt.getTime() > now.getTime())
      ) {
        return 'skipped';
      }

      const status = await this.processor.applyAndPersist(tx, wallet, {
        isNew: false,
        ctx: {
          correlationId: this.ids.next(),
          causationId: tx.id,
          occurredAt: now,
          nextId: () => this.ids.next(),
        },
      });

      if (status === WagerTransactionStatus.Processed) return 'processed';
      if (status === WagerTransactionStatus.Rejected) return 'rejected';
      return 'rescheduled';
    });
  }
}