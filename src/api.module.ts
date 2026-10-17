import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { MetricsModule } from './shared/infrastructure/observability/metrics.module';
import { SqsModule } from './shared/infrastructure/sqs/sqs.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { WageringHttpModule } from './modules/wagering/wagering-http.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { LoggingModule } from './shared/infrastructure/observability/logging.module';

@Module({
  imports: [LoggingModule, CoreModule, CoreModule, SqsModule, MetricsModule, AuthModule, HealthModule, WalletModule, WageringHttpModule],
})
export class ApiModule {}