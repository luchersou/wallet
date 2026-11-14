import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxRepository, type OutboxStats } from '../../application/ports/outbox.repository';
import { OutboxRecord } from './messaging.schema';

const toDomain = (r: OutboxRecord): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: r.publishedAt ?? undefined,
    lastError: r.lastError ?? undefined,
  });

const applyMutable = (m: OutboxMessage, r: OutboxRecord): void => {
  r.attempts = m.attempts;
  r.nextAttemptAt = m.nextAttemptAt;
  r.publishedAt = m.publishedAt ?? null;
  r.lastError = m.lastError ?? null;
};

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(message: OutboxMessage): Promise<void> {
    const record = Object.assign(new OutboxRecord(), {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
    });
    applyMutable(message, record);
    this.em.persist(record);
    await this.em.flush();
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
        orderBy: { nextAttemptAt: 'asc', occurredAt: 'asc' },
        limit,
      },
    );
    return records.map(toDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const record = await this.em.findOneOrFail(OutboxRecord, { id: message.id });
    applyMutable(message, record);
    await this.em.flush();
  }

  async stats(now: Date): Promise<OutboxStats> {
    const rows = (await this.em.execute(
      `select count(*)::int as pending,
              coalesce(extract(epoch from (?::timestamptz - min(occurred_at))) * 1000, 0)::float8 as oldest_ms
         from outbox_messages
        where published_at is null`,
      [now],
    )) as { pending: number; oldest_ms: number }[];
    const row = rows[0] ?? { pending: 0, oldest_ms: 0 };
    return { pending: row.pending, oldestPendingAgeMs: Math.max(0, row.oldest_ms) };
  }

  async saveMany(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const records = await this.em.find(OutboxRecord, { id: { $in: messages.map((m) => m.id) } });
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const message of messages) {
      const record = byId.get(message.id);
      if (record) applyMutable(message, record);
    }
    await this.em.flush(); // one flush for the whole batch
  }
}