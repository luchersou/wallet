import { Module } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet.use-case';
import { ReconcileWallet } from './application/reconcile-wallet.use-case';
import { WalletQueries } from './application/wallet.queries';
import { WalletController } from './infrastructure/http/wallet.controller';

@Module({
  controllers: [WalletController],
  providers: [OpenWallet, ReconcileWallet, WalletQueries],
})
export class WalletModule {}