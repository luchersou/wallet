import type { FailureCode } from '../../../../shared/domain/failure-code';
import { IntegrationEvent, type EventContext } from '../../../../shared/domain/integration-event';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation.error';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';
import { wagerEventData, type WagerTransactionEventData } from './wager-event-data';

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode || !tx.observedBalance) {
      throw new InvariantViolationError('WagerTransactionRejected requires a rejected transaction');
    }
    return new WagerTransactionRejected({
      eventId: ctx.nextId(),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...wagerEventData(tx),
        failureCode: tx.failureCode,
        balance: tx.observedBalance.toJSON(),
      },
    });
  }
}