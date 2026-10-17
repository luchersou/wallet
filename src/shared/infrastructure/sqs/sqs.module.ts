import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../../../config/env';

export const SQS_CONFIG = Symbol('SQS_CONFIG');

export interface SqsConfig {
  wagerQueue: string;
  wagerDlq: string;
  eventsQueue: string;
  maxReceiveCount: number;
}

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () =>
        new SQSClient({
          region: env.AWS_REGION,
          endpoint: env.AWS_ENDPOINT,
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          },
        }),
    },
    {
      provide: SQS_CONFIG,
      useValue: {
        wagerQueue: env.SQS_WAGER_QUEUE,
        wagerDlq: env.SQS_WAGER_DLQ,
        eventsQueue: env.SQS_EVENTS_QUEUE,
        maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
      } satisfies SqsConfig,
    },
  ],
  exports: [SQSClient, SQS_CONFIG],
})
export class SqsModule {}