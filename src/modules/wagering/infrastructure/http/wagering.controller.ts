import { Body, Controller, Get, Headers, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvalidPayloadError } from '../../../../shared/domain/invalid-payload.error';
import { UuidSchema, ZodPipe } from '../../../../shared/infrastructure/http/zod.pipe';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction.use-case';
import type { WagerResult } from '../../application/wager-result';
import { WageringQueries, type TransactionView } from '../../application/wagering.queries';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { SubmitWagerSchema, type SubmitWagerDto } from './dto/wager.dto';
import { Metrics } from '../../../../shared/application/ports/metrics.port';
import { assertProviderAccess } from '../../../auth/provider-identity.port';

const STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WageringQueries,
    private readonly metrics: Metrics,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(SubmitWagerSchema)) body: SubmitWagerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const key = idempotencyKey?.trim();
    if (!key) throw new InvalidPayloadError('Idempotency-Key header is required');
    if (key.length > 255) throw new InvalidPayloadError('Idempotency-Key is too long');
    assertProviderAccess(req.identity, body.providerId);

    const startedAt = performance.now();
    const result = await this.processWager.execute({
      ...body,
      idempotencyKey: key,
      correlationId: req.correlationId ?? Bun.randomUUIDv7(),
      source: { type: 'http' },
    });

    this.metrics.transactionCompleted(result.status, 'http', (performance.now() - startedAt) / 1000);
    if (result.idempotentReplay) this.metrics.duplicateDetected('http');

    res.status(STATUS_BY_RESULT[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId', new ZodPipe(UuidSchema)) transactionId: string): Promise<TransactionView> {
    return this.queries.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: Request,
  ): Promise<TransactionView> {
    assertProviderAccess(req.identity, providerId);
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}