import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { env } from './config/env';
import { configureApp } from './shared/infrastructure/http/configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule, { bufferLogs: true });
  configureApp(app);
  await app.listen(env.PORT);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});