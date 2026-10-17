import type { NextFunction, Request, Response } from 'express';
import { LogContext } from '../../observability/log-context';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
  }
}

const HEADER = 'x-correlation-id';
const VALID = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const correlationId = incoming && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
  req.correlationId = correlationId;
  res.setHeader(HEADER, correlationId);
  LogContext.run({ correlationId }, next);
}