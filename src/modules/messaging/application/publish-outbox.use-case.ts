import { Injectable } from '@nestjs/common';
import { Clock } from '../../../shared/application/ports/clock.port';
import { Metrics } from '../../../shared/application/ports/metrics.port';
import { TransactionRunner } from '../../../shared/application/ports/transaction-runner.port';
import { EventPublisher, PUBLISH_BATCH_LIMIT } from './ports/event-publisher.port';
import { OutboxRepository, type OutboxStats } from './ports/outbox.repository';

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

@Injectable()
export class PublishOutbox {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  /**
   * Claim with SKIP LOCKED: concurrent publishers claim disjoint batches.
   * Sent in batches of 10 (SendMessageBatch), sequentially to preserve the order
   * per wallet within the claim. If the process dies after publishing and before the commit,
   * the messages come back and are republished with the same eventId (dedup in SQS and in the consumer).
   */
  async publishBatch(limit: number): Promise<number> {
    const published = await this.runner.run(async () => {
      const batch = await this.outbox.claimDue(this.clock.now(), limit);
      let count = 0;

      for (let i = 0; i < batch.length; i += PUBLISH_BATCH_LIMIT) {
        const chunk = batch.slice(i, i + PUBLISH_BATCH_LIMIT);

        let failed: Map<string, string>;
        try {
          ({ failed } = await this.publisher.publishBatch(chunk));
        } catch (err) {
          failed = new Map(chunk.map((m) => [m.id, describe(err)]));
        }

        const now = this.clock.now();
        for (const message of chunk) {
          const error = failed.get(message.id);
          if (error === undefined) {
            message.markPublished(now);
            count++;
          } else {
            message.scheduleRetry(now, error);
            this.metrics.retryScheduled('outbox');
          }
        }
      }

      await this.outbox.saveMany(batch);
      return count;
    });

    this.metrics.outboxPublished(published);
    return published;
  }

  async observeLag(): Promise<OutboxStats> {
    const stats = await this.runner.run(() => this.outbox.stats(this.clock.now()));
    this.metrics.outboxObserved(stats.pending, stats.oldestPendingAgeMs / 1000);
    return stats;
  }
}