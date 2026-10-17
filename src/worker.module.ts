import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { LoggingModule } from './shared/infrastructure/observability/logging.module';
import { MetricsModule } from './shared/infrastructure/observability/metrics.module';
import { SqsModule } from './shared/infrastructure/sqs/sqs.module';
import { HealthModule } from './modules/health/health.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import {
  CONSUMER_OPTIONS,
  readConsumerOptions,
  WagerTransactionConsumer,
} from './modules/wagering/infrastructure/messaging/wager-transaction.consumer';
import { PendingReferenceWorker } from './modules/wagering/infrastructure/scheduling/pending-reference.worker';
import { WageringModule } from './modules/wagering/wagering.module';
import { WorkerLifecycle } from './worker.lifecycle';

@Module({
  imports: [LoggingModule, CoreModule, SqsModule, MetricsModule, HealthModule, WageringModule, MessagingModule],
  providers: [
    { provide: CONSUMER_OPTIONS, useFactory: readConsumerOptions },
    WagerTransactionConsumer,
    PendingReferenceWorker,
    WorkerLifecycle,
  ],
})
export class WorkerModule {}