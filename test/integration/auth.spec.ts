import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { ApiModule } from '../../src/api.module';
import { configureApp } from '../../src/shared/infrastructure/http/configure-app';
import { assertGlobalLedgerInvariant } from '../helpers/invariants';

/**
 * Exercises AUTH_MODE=keycloak without starting Keycloak: the keys are generated in the test
 * and a local JWKS plays the role of the realm's certificates endpoint.
 */
const ISSUER = 'http://issuer.test/realms/jungle';
const AUDIENCE = 'wallet-api';
const uuid = () => Bun.randomUUIDv7();

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let app: INestApplication;
let orm: MikroORM;
let baseUrl: string;
let jwksServer: ReturnType<typeof Bun.serve>;
let signingKey: PrivateKey;
let foreignKey: PrivateKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });

  process.env.LOG_LEVEL = 'silent';
  process.env.AUTH_MODE = 'keycloak';
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_AUDIENCE = AUDIENCE;
  process.env.OIDC_JWKS_URL = `http://localhost:${jwksServer.port}/certs`;

  app = await NestFactory.create(ApiModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  orm = app.get(MikroORM);
});

afterAll(async () => {
  await app.close();
  jwksServer.stop(true);
  process.env.AUTH_MODE = 'disabled';
});

beforeEach(async () => {
  await orm.em.getConnection().execute(
    `truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade`,
  );
});

afterEach(async () => {
  await assertGlobalLedgerInvariant(orm);
});

interface TokenOptions {
  key?: PrivateKey;
  audience?: string;
  issuer?: string;
  expiresAt?: number;
}

async function token(claims: Record<string, unknown>, o: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: 'test-client', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? AUDIENCE)
    .setSubject('service-account')
    .setIssuedAt(now - 120)
    .setExpirationTime(o.expiresAt ?? now + 300)
    .sign(o.key ?? signingKey);
}

const backoffice = () => token({});
const provider = (id: string) => token({ provider_id: id });

async function call(method: string, path: string, body?: unknown, bearer?: string, extra: Record<string, string> = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as any, headers: res.headers };
}

async function createWallet() {
  const playerId = uuid();
  const res = await call('POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }, await backoffice());
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function bet(w: { walletId: string; playerId: string }, providerId: string) {
  const externalTransactionId = `tx-${uuid()}`;
  return {
    key: `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
  };
}

describe('authentication (AUTH_MODE=keycloak)', () => {
  it('keeps health and metrics public', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
  });

  it('rejects requests without a token with 401 and WWW-Authenticate', async () => {
    const res = await call('POST', '/wallets', { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects expired, foreign-signed, wrong-audience and wrong-issuer tokens', async () => {
    const path = `/wallets/${uuid()}`;
    const past = Math.floor(Date.now() / 1000) - 60;
    for (const bad of [
      await token({}, { expiresAt: past }),
      await token({}, { key: foreignKey }),
      await token({}, { audience: 'another-api' }),
      await token({}, { issuer: 'http://evil.test/realms/jungle' }),
      'not-a-jwt',
    ]) {
      expect((await call('GET', path, undefined, bad)).status).toBe(401);
    }
  });

  it('lets a provider submit transactions as itself', async () => {
    const w = await createWallet();
    const { key, body } = bet(w, 'provider-a');
    const res = await call('POST', '/wagering/transactions', body, await provider('provider-a'), { 'idempotency-key': key });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
  });

  it('forbids a provider from acting as another provider (403)', async () => {
    const w = await createWallet();
    const { key, body } = bet(w, 'provider-b');
    const res = await call('POST', '/wagering/transactions', body, await provider('provider-a'), { 'idempotency-key': key });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('forbids clients without provider identity from submitting transactions', async () => {
    const w = await createWallet();
    const { key, body } = bet(w, 'provider-a');
    const res = await call('POST', '/wagering/transactions', body, await backoffice(), { 'idempotency-key': key });
    expect(res.status).toBe(403);
  });

  it('scopes provider queries to the authenticated provider', async () => {
    const w = await createWallet();
    const { key, body } = bet(w, 'provider-a');
    await call('POST', '/wagering/transactions', body, await provider('provider-a'), { 'idempotency-key': key });

    const path = `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`;
    expect((await call('GET', path, undefined, await provider('provider-a'))).status).toBe(200);
    expect((await call('GET', path, undefined, await provider('provider-b'))).status).toBe(403);
  });
});