import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { correlationIdMiddleware } from './correlation-id.middleware';
import { DomainExceptionFilter } from './domain-exception.filter';

/** Mesma configuração no main e nos testes HTTP. */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();
}