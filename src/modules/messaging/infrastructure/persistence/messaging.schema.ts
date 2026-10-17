import { EntitySchema } from '@mikro-orm/core';

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  lastError?: string | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'string', nullable: true },
  },
});