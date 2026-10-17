import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { buildPinoHttpOptions } from './logging';

@Module({
  imports: [
    // forRootAsync: opções lidas no bootstrap (permite LOG_LEVEL=silent nos testes)
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: buildPinoHttpOptions() }),
    }),
  ],
})
export class LoggingModule {}