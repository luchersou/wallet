import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env';
import { configureApp } from './shared/infrastructure/http/configure-app';
import { WorkerModule } from './worker.module';

/** Worker process: only exposes /health and /metrics; the work runs in the loops. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule);
  configureApp(app);
  await app.listen(env.WORKER_PORT);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});