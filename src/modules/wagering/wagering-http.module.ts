import { Module } from '@nestjs/common';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WageringModule } from './wagering.module';

@Module({
  imports: [WageringModule],
  controllers: [WageringController],
})
export class WageringHttpModule {}