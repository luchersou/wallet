import type { IntegrationEvent } from '../../../shared/domain/integration-event';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  /** id da outbox = eventId: chave de dedup no SQS e no consumidor. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt,
      s.attempts, s.nextAttemptAt, s.publishedAt, s.lastError,
    );
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }
  get lastError(): string | undefined { return this._lastError; }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /** Incrementa attempts e agenda com backoff exponencial (1s → teto 60s). */
  scheduleRetry(now: Date, error?: string): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, 500);
  }
}