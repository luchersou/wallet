import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),

  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wallet-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),

  REFERENCE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
  REFERENCE_RETRY_MAX_MS: z.coerce.number().int().positive().default(300_000),

  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);