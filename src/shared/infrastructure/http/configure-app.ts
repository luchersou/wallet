import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { correlationIdMiddleware } from './correlation-id.middleware';
import { DomainExceptionFilter } from './domain-exception.filter';

/** Same configuration in main and in the HTTP tests. */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();
}