import type { OutboxMessage } from '../../domain/outbox-message';

export interface OutboxStats {
  pending: number;
  oldestPendingAgeMs: number;
}

export abstract class OutboxRepository {
  abstract add(message: OutboxMessage): Promise<void>;
  /** FOR UPDATE SKIP LOCKED — requires a transaction; concurrent publishers claim disjoint batches. */
  abstract claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  abstract save(message: OutboxMessage): Promise<void>;
  abstract stats(now: Date): Promise<OutboxStats>;
  abstract saveMany(messages: OutboxMessage[]): Promise<void>;
}