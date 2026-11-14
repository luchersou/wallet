import { Inject, Injectable } from '@nestjs/common';
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CONFIG, type SqsConfig } from '../../../shared/infrastructure/sqs/sqs.module';
import { EventPublisher, type PublishBatchResult } from '../application/ports/event-publisher.port';
import type { OutboxMessage } from '../domain/outbox-message';

@Injectable()
export class SqsEventPublisher extends EventPublisher {
  private queueUrl?: string;

  constructor(
    private readonly sqs: SQSClient,
    @Inject(SQS_CONFIG) private readonly config: SqsConfig,
  ) {
    super();
  }

  async publishBatch(messages: OutboxMessage[]): Promise<PublishBatchResult> {
    const failed = new Map<string, string>();
    if (messages.length === 0) return { failed };

    const res = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.url(),
        Entries: messages.map((m, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(m.payload),
          MessageGroupId: m.aggregateId, // order per wallet
          MessageDeduplicationId: m.id, // = eventId
          MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
        })),
      }),
    );

    // Partial failure: SQS reports entry by entry
    for (const entry of res.Failed ?? []) {
      const message = messages[Number(entry.Id)];
      if (message) failed.set(message.id, `${entry.Code ?? 'Error'}: ${entry.Message ?? ''}`);
    }
    return { failed };
  }

  private async url(): Promise<string> {
    if (!this.queueUrl) {
      const res = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.eventsQueue }));
      if (!res.QueueUrl) throw new Error(`queue ${this.config.eventsQueue} not found`);
      this.queueUrl = res.QueueUrl;
    }
    return this.queueUrl;
  }
}