import type { IncomingMessage, ServerResponse } from 'node:http';
import pino, { type LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { LogContext } from '../../observability/log-context';

/** Defensive: the body is never logged, but financial fields and credentials are masked if they show up. */
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
    // Request metadata only: never the body or full headers
    serializers: {
      req: (req: Req) => ({ method: req.method, url: req.originalUrl ?? req.url }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  };
}