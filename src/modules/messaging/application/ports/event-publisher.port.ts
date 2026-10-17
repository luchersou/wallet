import type { OutboxMessage } from '../../domain/outbox-message';

/** Até 10 mensagens por chamada (limite do SendMessageBatch). */
export const PUBLISH_BATCH_LIMIT = 10;

export interface PublishBatchResult {
  /** id da outbox → motivo da falha. Ausente = publicada. */
  failed: Map<string, string>;
}

export abstract class EventPublisher {
  abstract publishBatch(messages: OutboxMessage[]): Promise<PublishBatchResult>;
}