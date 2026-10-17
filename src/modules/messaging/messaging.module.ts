import { Module } from '@nestjs/common';
import { EventPublisher } from './application/ports/event-publisher.port';
import { PublishOutbox } from './application/publish-outbox.use-case';
import { OutboxPublisherWorker } from './infrastructure/outbox-publisher.worker';
import { SqsEventPublisher } from './infrastructure/sqs-event-publisher';

@Module({
  providers: [{ provide: EventPublisher, useClass: SqsEventPublisher }, PublishOutbox, OutboxPublisherWorker],
  exports: [PublishOutbox, OutboxPublisherWorker],
})
export class MessagingModule {}