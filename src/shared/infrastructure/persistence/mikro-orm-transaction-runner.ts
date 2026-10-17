import { Injectable, Optional } from '@nestjs/common';
import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError, UniqueConstraintConflictError } from '../../application/errors';
import { Metrics, NoopMetrics } from '../../application/ports/metrics.port';
import { TransactionRunner } from '../../application/ports/transaction-runner.port';

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  '08000', '08001', '08003', '08006',
  '40001', '40P01',
  '55P03',
  '57P01', '57P02', '57P03',
]);

const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

@Injectable()
export class MikroOrmTransactionRunner extends TransactionRunner {
  private readonly metrics: Metrics;

  constructor(
    private readonly em: EntityManager,
    @Optional() metrics?: Metrics,
  ) {
    super();
    this.metrics = metrics ?? new NoopMetrics();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      // transactional() registra o fork no TransactionContext:
      // o EntityManager injetado nos repositórios resolve para esta transação.
      return await this.em.fork().transactional(() => work());
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        throw new UniqueConstraintConflictError(err);
      }

      const code = codeOf(err);
      if (err instanceof DeadlockException || code === '40P01') this.metrics.lockConflict('deadlock');
      if (err instanceof LockWaitTimeoutException || code === '55P03') this.metrics.lockConflict('lock_timeout');

      if (
        err instanceof ConnectionException ||
        err instanceof DeadlockException ||
        err instanceof LockWaitTimeoutException ||
        (code !== undefined && TRANSIENT_CODES.has(code))
      ) {
        throw new TransientInfrastructureError((err as Error).message, err);
      }
      throw err;
    }
  }
}