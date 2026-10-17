import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../../modules/auth/public.decorator';
import { PromMetrics } from './prom-metrics';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PromMetrics) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.type(this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}