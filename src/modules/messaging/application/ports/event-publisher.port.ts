import type { OutboxMessage } from '../../domain/outbox-message';

/** Up to 10 messages per call (SendMessageBatch limit). */
export const PUBLISH_BATCH_LIMIT = 10;

export interface PublishBatchResult {
  /** outbox id → failure reason. Absent = published. */
  failed: Map<string, string>;
}

export abstract class EventPublisher {
  abstract publishBatch(messages: OutboxMessage[]): Promise<PublishBatchResult>;
}