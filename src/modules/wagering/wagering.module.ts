import { Module } from '@nestjs/common';
import { env } from '../../config/env';
import { ProcessWagerTransaction } from './application/process-wager-transaction.use-case';
import { RetryPendingReference } from './application/retry-pending-reference.use-case';
import { WagerTransactionProcessor } from './application/wager-transaction-processor';
import { WageringQueries } from './application/wagering.queries';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';

@Module({
  providers: [
    {
      provide: ReferenceRetryPolicy,
      useFactory: () =>
        new ReferenceRetryPolicy(
          env.REFERENCE_RETRY_MAX_ATTEMPTS,
          env.REFERENCE_RETRY_BASE_MS,
          env.REFERENCE_RETRY_MAX_MS,
        ),
    },
    WagerTransactionProcessor,
    ProcessWagerTransaction,
    RetryPendingReference,
    WageringQueries,
  ],
  exports: [ProcessWagerTransaction, RetryPendingReference, WageringQueries, ReferenceRetryPolicy],
})
export class WageringModule {}