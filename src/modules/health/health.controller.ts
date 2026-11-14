import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MikroORM } from '@mikro-orm/core';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CONFIG, type SqsConfig } from '../../shared/infrastructure/sqs/sqs.module';
import { Public } from '../auth/public.decorator';

interface CheckResult {
  ok: boolean;
  error?: string;
}

async function check(fn: () => Promise<unknown>, timeoutMs = 2_000): Promise<CheckResult> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    @Inject(SQS_CONFIG) private readonly sqsConfig: SqsConfig,
  ) {}

  /** Process alive — does not depend on anything external. */
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS reachable. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('select 1')),
      check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: this.sqsConfig.wagerQueue }))),
    ]);
    const ok = postgres.ok && sqs.ok;
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}