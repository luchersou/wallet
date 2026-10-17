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
   * Claim com SKIP LOCKED: publishers concorrentes pegam lotes disjuntos.
   * Envio em lotes de 10 (SendMessageBatch), em sequência para preservar a ordem
   * por wallet dentro do claim. Se o processo morrer após publicar e antes do commit,
   * as mensagens voltam e são republicadas com o mesmo eventId (dedup no SQS e no consumidor).
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