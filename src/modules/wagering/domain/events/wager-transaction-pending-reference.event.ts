import { IntegrationEvent, type EventContext } from '../../../../shared/domain/integration-event';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation.error';
import type { WagerTransaction } from '../wager-transaction';
import { wagerEventData, type WagerTransactionEventData } from './wager-event-data';

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId || !tx.nextReferenceAttemptAt) {
      throw new InvariantViolationError('PendingReference event requires a pending transaction');
    }
    return new WagerTransactionPendingReference({
      eventId: ctx.nextId(),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...wagerEventData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}