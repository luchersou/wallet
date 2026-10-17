import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { Metrics, type RetryComponent, type TransactionSource } from '../../application/ports/metrics.port';

@Injectable()
export class PromMetrics extends Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wallet_transactions_total',
    help: 'Wager transactions by final status and entry point',
    labelNames: ['status', 'source'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wallet_transaction_processing_seconds',
    help: 'Wager transaction processing latency',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wallet_duplicates_detected_total',
    help: 'Idempotent replays and inbox duplicates',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wallet_retries_total',
    help: 'Retries scheduled, by component',
    labelNames: ['component'],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'wallet_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Concurrency conflicts (unique races, deadlocks, lock timeouts)',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'wallet_outbox_pending',
    help: 'Outbox messages not yet published',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wallet_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'wallet_outbox_published_total',
    help: 'Outbox messages published',
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });
  private readonly lockWaitHistogram = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time spent waiting for the wallet row lock (SELECT ... FOR UPDATE)',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  transactionCompleted(status: string, source: TransactionSource, durationSeconds?: number): void {
    this.transactions.inc({ status, source });
    if (durationSeconds !== undefined) this.duration.observe({ source }, durationSeconds);
  }
  duplicateDetected(source: TransactionSource): void {
    this.duplicates.inc({ source });
  }
  retryScheduled(component: RetryComponent): void {
    this.retries.inc({ component });
  }
  deadLettered(reason: string): void {
    this.dlq.inc({ reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  lockWait(seconds: number): void {
    this.lockWaitHistogram.observe(seconds);
  }
  outboxObserved(pending: number, oldestLagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestLagSeconds);
  }
  outboxPublished(count: number): void {
    if (count > 0) this.outboxPublishedTotal.inc(count);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}