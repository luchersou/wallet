import { Global, Module } from '@nestjs/common';
import { Metrics } from '../../application/ports/metrics.port';
import { MetricsController } from './metrics.controller';
import { PromMetrics } from './prom-metrics';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [PromMetrics, { provide: Metrics, useExisting: PromMetrics }],
  exports: [Metrics, PromMetrics],
})
export class MetricsModule {}