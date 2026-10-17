import type { IncomingMessage, ServerResponse } from 'node:http';
import pino, { type LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { LogContext } from '../../observability/log-context';

/** Defensivo: o corpo nunca é logado, mas campos financeiros e credenciais são mascarados se aparecerem. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'money',
  '*.money',
  'balance',
  '*.balance',
  'initialBalance',
  '*.initialBalance',
];

export function buildLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: process.env.SERVICE_NAME ?? 'wallet' },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...LogContext.get() }),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
}

type Req = IncomingMessage & { correlationId?: string; originalUrl?: string };

export function buildPinoHttpOptions(): PinoHttpOptions {
  return {
    ...buildLoggerOptions(),
    genReqId: (req: Req) => req.correlationId ?? Bun.randomUUIDv7(),
    customProps: (req: Req) => ({ correlationId: req.correlationId }),
    autoLogging: {
      ignore: (req: Req) => {
        const url = req.originalUrl ?? req.url ?? '';
        return url.startsWith('/health') || url.startsWith('/metrics');
      },
    },
    // Só metadados da requisição: nunca corpo nem headers completos
    serializers: {
      req: (req: Req) => ({ method: req.method, url: req.originalUrl ?? req.url }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  };
}