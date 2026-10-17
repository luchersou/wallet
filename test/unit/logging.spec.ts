import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LogContext } from '../../src/shared/observability/log-context';
import { buildLoggerOptions } from '../../src/shared/infrastructure/observability/logging';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ ...buildLoggerOptions(), level: 'info' }, stream), lines };
}

describe('structured logging', () => {
  it('emits JSON with the correlation context of the current scope', async () => {
    const { logger, lines } = captureLogger();

    await LogContext.run({ correlationId: 'corr-1', messageId: 'msg-1' }, async () => {
      LogContext.assign({ transactionId: 'tx-1', walletId: 'w-1', providerId: 'provider-a' });
      await Bun.sleep(1); // atravessa uma fronteira assíncrona
      logger.info({ status: 'PROCESSED' }, 'wager_transaction_completed');
    });

    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'wager_transaction_completed',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'w-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
    });
    expect(typeof lines[0]!.time).toBe('string');
  });

  it('does not leak context outside its scope', () => {
    const { logger, lines } = captureLogger();
    LogContext.run({ correlationId: 'inner' }, () => undefined);
    logger.info('outside');
    expect(lines[0]!.correlationId).toBeUndefined();
  });

  it('redacts credentials and financial payloads', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' } },
        money: { amount: '25.00', currency: 'BRL' },
        payload: { balance: { amount: '975.00', currency: 'BRL' } },
      },
      'request',
    );
    const line = lines[0] as Record<string, any>;
    expect(line.req.headers.authorization).toBe('[REDACTED]');
    expect(line.req.headers.cookie).toBe('[REDACTED]');
    expect(line.money).toBe('[REDACTED]');
    expect(line.payload.balance).toBe('[REDACTED]');
  });
});