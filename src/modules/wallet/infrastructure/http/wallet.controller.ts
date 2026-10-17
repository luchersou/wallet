import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UuidSchema, ZodPipe } from '../../../../shared/infrastructure/http/zod.pipe';
import { OpenWallet, type WalletView } from '../../application/open-wallet.use-case';
import { ReconcileWallet, type ReconciliationView } from '../../application/reconcile-wallet.use-case';
import { WalletQueries, type LedgerPageView } from '../../application/wallet.queries';
import { LedgerQuerySchema, OpenWalletSchema, type LedgerQueryDto, type OpenWalletDto } from './dto/wallet.dto';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WalletQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  open(@Body(new ZodPipe(OpenWalletSchema)) body: OpenWalletDto, @Req() req: Request): Promise<WalletView> {
    return this.openWallet.execute({ ...body, correlationId: req.correlationId ?? Bun.randomUUIDv7() });
  }

  @Get(':walletId')
  get(@Param('walletId', new ZodPipe(UuidSchema)) walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ZodPipe(UuidSchema)) walletId: string,
    @Query(new ZodPipe(LedgerQuerySchema)) query: LedgerQueryDto,
  ): Promise<LedgerPageView> {
    return this.queries.listLedger(walletId, query.cursor, query.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', new ZodPipe(UuidSchema)) walletId: string): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(walletId);
  }
}