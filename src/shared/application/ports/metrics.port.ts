export type TransactionSource = 'http' | 'sqs' | 'worker';
export type RetryComponent = 'consumer' | 'outbox' | 'pending_reference';

export abstract class Metrics {
  abstract transactionCompleted(status: string, source: TransactionSource, durationSeconds?: number): void;
  abstract duplicateDetected(source: TransactionSource): void;
  abstract retryScheduled(component: RetryComponent): void;
  abstract deadLettered(reason: string): void;
  abstract lockConflict(reason: string): void;
  abstract lockWait(seconds: number): void;
  abstract outboxObserved(pending: number, oldestLagSeconds: number): void;
  abstract outboxPublished(count: number): void;
  abstract reconciliationDivergence(): void;
}

export class NoopMetrics extends Metrics {
  transactionCompleted(): void {}
  duplicateDetected(): void {}
  retryScheduled(): void {}
  deadLettered(): void {}
  lockConflict(): void {}
  lockWait(): void {}
  outboxObserved(): void {}
  outboxPublished(): void {}
  reconciliationDivergence(): void {}
}