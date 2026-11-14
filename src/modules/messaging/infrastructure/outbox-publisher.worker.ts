import { Injectable } from '@nestjs/common';
import { env } from '../../../config/env';
import { PollingLoop } from '../../../shared/infrastructure/polling-loop';
import { PublishOutbox } from '../application/publish-outbox.use-case';

@Injectable()
export class OutboxPublisherWorker {
  private readonly loop: PollingLoop;

  constructor(private readonly publishOutbox: PublishOutbox) {
    this.loop = new PollingLoop('OutboxPublisher', env.OUTBOX_POLL_INTERVAL_MS, () => this.tick());
  }

  async tick(): Promise<void> {
    let published: number;
    do {
      published = await this.publishOutbox.publishBatch(env.OUTBOX_BATCH_SIZE);
    } while (published === env.OUTBOX_BATCH_SIZE); // drain while batches are full
    await this.publishOutbox.observeLag();
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}