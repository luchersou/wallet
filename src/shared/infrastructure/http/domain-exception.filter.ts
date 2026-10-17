import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { TransientInfrastructureError } from '../../application/errors';
import { DomainError } from '../../domain/domain-error';
import { FailureCode } from '../../domain/failure-code';

const STATUS_BY_CODE: Partial<Record<FailureCode, number>> = {
  [FailureCode.InvalidPayload]: 400,
  [FailureCode.InvalidMoney]: 400,
  [FailureCode.CurrencyMismatch]: 400,
  [FailureCode.WalletPlayerMismatch]: 400,
  [FailureCode.WalletNotFound]: 404,
  [FailureCode.TransactionNotFound]: 404,
  [FailureCode.IdempotencyConflict]: 409,
  [FailureCode.WalletAlreadyExists]: 409,
};

export interface MappedError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof ZodError) {
    return {
      status: 400,
      code: FailureCode.InvalidPayload,
      message: 'Request validation failed',
      retryable: false,
      details: err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    };
  }
  if (err instanceof DomainError) {
    return { status: STATUS_BY_CODE[err.code] ?? 422, code: err.code, message: err.message, retryable: false };
  }
  if (err instanceof TransientInfrastructureError) {
    return {
      status: 503,
      code: FailureCode.TransientInfrastructureError,
      message: 'Temporary infrastructure failure, retry with the same Idempotency-Key',
      retryable: true,
    };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    return {
      status,
      code: status === 404 ? 'NOT_FOUND' : status < 500 ? FailureCode.InvalidPayload : FailureCode.InternalError,
      message: err.message,
      retryable: false,
    };
  }
  return { status: 500, code: FailureCode.InternalError, message: 'Internal error', retryable: false };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const mapped = mapError(exception);

    if (mapped.status >= 500) {
      this.logger.error(
        `${req.method} ${req.path} failed [${req.correlationId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (mapped.status === 503) res.setHeader('Retry-After', '1');

    res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
      correlationId: req.correlationId,
    });
  }
}