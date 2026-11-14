import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { buildPinoHttpOptions } from './logging';

@Module({
  imports: [
    // forRootAsync: options read at bootstrap (allows LOG_LEVEL=silent in tests)
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: buildPinoHttpOptions() }),
    }),
  ],
})
export class LoggingModule {}