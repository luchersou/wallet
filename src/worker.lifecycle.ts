import { Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { env } from './config/env';
import { OutboxPublisherWorker } from './modules/messaging/infrastructure/outbox-publisher.worker';
import { WagerTransactionConsumer } from './modules/wagering/infrastructure/messaging/wager-transaction.consumer';
import { PendingReferenceWorker } from './modules/wagering/infrastructure/scheduling/pending-reference.worker';

@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Worker');

  constructor(
    private readonly consumer: WagerTransactionConsumer,
    private readonly outboxPublisher: OutboxPublisherWorker,
    private readonly pendingReferences: PendingReferenceWorker,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKER_AUTOSTART === 'false') return;
    this.consumer.start();
    this.outboxPublisher.start();
    this.pendingReferences.start();
    this.logger.log('consumer, outbox publisher and pending-reference worker started');
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`shutting down (${signal ?? 'no signal'}), draining in-flight work`);
    await Promise.all([
      this.consumer.stop(env.SHUTDOWN_TIMEOUT_MS),
      this.outboxPublisher.stop(),
      this.pendingReferences.stop(),
    ]);
    this.logger.log('shutdown complete');
  }
}