import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../../../config/env';
import { Clock } from '../../../../shared/application/ports/clock.port';
import { Metrics } from '../../../../shared/application/ports/metrics.port';
import { TransactionRunner } from '../../../../shared/application/ports/transaction-runner.port';
import { PollingLoop } from '../../../../shared/infrastructure/polling-loop';
import { RetryPendingReference } from '../../application/retry-pending-reference.use-case';
import { WagerTransactionRepository } from '../../domain/ports/wager-transaction.repository';
import { LogContext } from '../../../../shared/observability/log-context';

const BATCH = 50;

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger('PendingReferenceWorker');
  private readonly loop: PollingLoop;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly txs: WagerTransactionRepository,
    private readonly retryPending: RetryPendingReference,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {
    this.loop = new PollingLoop('PendingReferenceWorker', env.PENDING_REFERENCE_POLL_INTERVAL_MS, () => this.tick());
  }

  async tick(): Promise<void> {
    const ids = await this.runner.run(() => this.txs.findDuePendingReferenceIds(this.clock.now(), BATCH));

    for (const id of ids) {
      await LogContext.run({ transactionId: id }, async () => {
        try {
          const outcome = await this.retryPending.execute(id);
          if (outcome === 'rescheduled') this.metrics.retryScheduled('pending_reference');
          if (outcome === 'processed') this.metrics.transactionCompleted('PROCESSED', 'worker');
          if (outcome === 'rejected') this.metrics.transactionCompleted('REJECTED', 'worker');
        } catch (err) {
          this.logger.error(`retry of ${id} failed`, err instanceof Error ? err.stack : String(err));
        }
      });
    }
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}