import { IntegrationEvent, type EventContext } from '../../../../shared/domain/integration-event';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation.error';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';
import { wagerEventData, type WagerTransactionEventData } from './wager-event-data';

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.processedAt || !tx.observedBalance) {
      throw new InvariantViolationError('WagerTransactionProcessed requires a processed transaction');
    }
    return new WagerTransactionProcessed({
      eventId: ctx.nextId(),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...wagerEventData(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.observedBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}