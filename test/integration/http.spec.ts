import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { ApiModule } from '../../src/api.module';
import { configureApp } from '../../src/shared/infrastructure/http/configure-app';
import { assertGlobalLedgerInvariant } from '../helpers/invariants';

const uuid = () => Bun.randomUUIDv7();

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;

beforeAll(async () => {
  process.env.AUTH_MODE = 'disabled';
  process.env.LOG_LEVEL = 'silent';
  app = await NestFactory.create(ApiModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  orm = app.get(MikroORM);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await orm.em.getConnection().execute(
    `truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade`,
  );
});

afterEach(async () => {
  await assertGlobalLedgerInvariant(orm);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: Json = await res.json().catch(() => undefined);
  return { status: res.status, body: json, headers: res.headers };
}

async function createWallet(amount = '100.00') {
  const playerId = uuid();
  const res = await call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  return { playerId, walletId: res.body.id as string, res };
}

function wagerBody(w: { walletId: string; playerId: string }, kind: string, amount: string, extra: object = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (body: Json, key = `provider-a:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'idempotency-key': key });

describe('HTTP API', () => {
  it('creates a wallet (201) and rejects duplicates (409)', async () => {
    const { res, playerId } = await createWallet('1000.00');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const dup = await call('POST', '/wallets', { playerId, initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('processes (200), replays (200) and detects conflicts (409)', async () => {
    const w = await createWallet('1000.00');
    const body = wagerBody(w, 'BET', '25.00');

    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00' }, idempotentReplay: false });

    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, idempotentReplay: true });

    const conflict = await submit({ ...body, money: { amount: '30.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('returns 422 for business rejections, with the transaction result', async () => {
    const w = await createWallet('10.00');
    const res = await submit(wagerBody(w, 'BET', '50.00'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(res.body.transactionId).toBeString();
  });

  it('returns 202 when the reference is pending', async () => {
    const w = await createWallet('10.00');
    const res = await submit(wagerBody(w, 'REFUND', '5.00', { referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  it('returns 400 for invalid payloads', async () => {
    const w = await createWallet();
    const missingKey = await call('POST', '/wagering/transactions', wagerBody(w, 'BET', '1.00'));
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.code).toBe('INVALID_PAYLOAD');

    const badMoney = await submit(wagerBody(w, 'BET', '1.5'));
    expect(badMoney.status).toBe(400);
    expect(badMoney.body.error.code).toBe('INVALID_MONEY');

    const badSchema = await submit({ ...wagerBody(w, 'BET', '1.00'), walletId: 'not-a-uuid' });
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.error.details).toBeArray();

    const opening = await submit(wagerBody(w, 'OPENING', '1.00'));
    expect(opening.status).toBe(400);
  });

  it('returns 404 for unknown resources', async () => {
    const w = await createWallet();
    expect((await submit(wagerBody({ ...w, walletId: uuid() }, 'BET', '1.00'))).status).toBe(404);
    expect((await call('GET', `/wallets/${uuid()}`)).status).toBe(404);
    expect((await call('GET', `/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  it('queries transactions by id and by provider external id', async () => {
    const w = await createWallet();
    const body = wagerBody(w, 'BET', '10.00');
    const { body: result } = await submit(body);

    const byId = await call('GET', `/wagering/transactions/${result.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', balance: { amount: '90.00' } });

    const byExt = await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.body.transactionId).toBe(result.transactionId);
  });

  it('paginates the ledger with an opaque cursor', async () => {
    const w = await createWallet('100.00');
    for (let i = 0; i < 4; i++) await submit(wagerBody(w, 'BET', '1.00'));

    const page1 = await call('GET', `/wallets/${w.walletId}/ledger?limit=3`);
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.nextCursor).toBeString();

    const page2 = await call('GET', `/wallets/${w.walletId}/ledger?limit=3&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();

    expect((await call('GET', `/wallets/${w.walletId}/ledger?cursor=garbage`)).status).toBe(400);
  });

  it('reconciles a consistent wallet', async () => {
    const w = await createWallet('100.00');
    await submit(wagerBody(w, 'BET', '25.00'));
    const res = await call('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: { amount: '75.00' },
      calculatedBalance: { amount: '75.00' },
      difference: { amount: '0.00' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('exposes liveness and readiness without auth', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres.ok).toBe(true);
    expect(ready.body.checks.sqs.ok).toBe(true);
  });

  it('propagates the correlation id', async () => {
    const res = await call('GET', '/health/live', undefined, { 'x-correlation-id': 'abc-123' });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
  });

    it('exposes Prometheus metrics for the HTTP flow', async () => {
    const w = await createWallet('100.00');
    const body = wagerBody(w, 'BET', '10.00');
    await submit(body);
    await submit(body); // replay

    const res = await fetch(`${baseUrl}/metrics`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('wallet_transactions_total{status="PROCESSED",source="http"}');
    expect(text).toContain('wallet_duplicates_detected_total{source="http"}');
    expect(text).toContain('wallet_lock_wait_seconds_bucket');
  });
});