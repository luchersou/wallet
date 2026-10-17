import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NoopAuthGuard } from './noop-auth.guard';

@Module({
  providers: [{ provide: APP_GUARD, useClass: NoopAuthGuard }],
})
export class AuthModule {}