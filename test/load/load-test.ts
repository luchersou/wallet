import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';

// ---------- configuração

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

const BASE_URL = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const DURATION_S = num(process.env.LOAD_DURATION_S, 30);
const CONCURRENCY = num(process.env.LOAD_CONCURRENCY, 50);
const COLD_WALLETS = num(process.env.LOAD_WALLETS, 50);
const HOT_RATIO = num(process.env.LOAD_HOT_RATIO, 0.2);
const REPLAY_RATIO = 0.1;

const TOKEN_URL =
  process.env.LOAD_TOKEN_URL ?? 'http://localhost:8080/realms/jungle/protocol/openid-connect/token';

const uuid = () => Bun.randomUUIDv7();

interface WalletRef {
  walletId: string;
  playerId: string;
}

interface Sample {
  latencyMs: number;
  status: number;
  kind: 'BET' | 'WIN' | 'REPLAY';
}

// ---------- helpers HTTP / métricas

/** Client credentials no Keycloak. Sem Keycloak (AUTH_MODE=disabled), segue sem token. */
async function fetchToken(clientId: string, secret: string): Promise<string | undefined> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { access_token: string }).access_token;
  } catch {
    return undefined;
  }
}

const bearer = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
let backofficeToken: string | undefined;
let providerToken: string | undefined;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
}

async function scrapeMetrics(): Promise<string> {
  return (await fetch(`${BASE_URL}/metrics`)).text();
}

/** Soma todas as séries de uma métrica (todas as combinações de labels). */
function metricSum(text: string, name: string): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && (line[name.length] === ' ' || line[name.length] === '{'))
    .reduce((acc, line) => acc + Number(line.trim().split(/\s+/).pop()), 0);
}

/** Quantil aproximado a partir dos buckets cumulativos de um histograma (delta antes/depois). */
function histogramQuantile(before: string, after: string, name: string, q: number): number | null {
  const buckets = (text: string) =>
    new Map(
      text
        .split('\n')
        .filter((l) => l.startsWith(`${name}_bucket{`))
        .map((l) => {
          const le = l.match(/le="([^"]+)"/)![1]!;
          return [le, Number(l.trim().split(/\s+/).pop())] as const;
        }),
    );
  const b = buckets(before);
  const a = buckets(after);
  const deltas = [...a.entries()].map(([le, v]) => ({ le, count: v - (b.get(le) ?? 0) }));
  const total = deltas.find((d) => d.le === '+Inf')?.count ?? 0;
  if (total === 0) return null;
  const target = total * q;
  const hit = deltas.find((d) => d.count >= target);
  return hit && hit.le !== '+Inf' ? Number(hit.le) : null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

// ---------- execução

async function createWallet(amount: string): Promise<WalletRef> {
  const playerId = uuid();
  const res = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } }, bearer(backofficeToken));
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...config, debug: false });
  const conn = orm.em.getConnection();

  backofficeToken = await fetchToken('backoffice', 'backoffice-secret');
  providerToken = await fetchToken('provider-a', 'provider-a-secret');
  console.log(`auth: ${providerToken ? 'keycloak tokens acquired' : 'no token (auth disabled?)'}`);

  console.log(`setup: ${COLD_WALLETS} wallets + 1 hot wallet @ ${BASE_URL}`);
  const hot = await createWallet('10000000.00');
  const cold = await Promise.all(Array.from({ length: COLD_WALLETS }, () => createWallet('10000000.00')));
  const allWallets = [hot, ...cold];

  const sent: { key: string; body: unknown }[] = [];
  const samples: Sample[] = [];
  let networkErrors = 0;

  // Amostragem do outbox lag durante a carga
  let maxLagSeconds = 0;
  let maxPending = 0;
  const sampler = setInterval(async () => {
    try {
      const rows = (await conn.execute(
        `select count(*)::int as pending,
                coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag
           from outbox_messages where published_at is null`,
      )) as { pending: number; lag: number }[];
      maxPending = Math.max(maxPending, rows[0]?.pending ?? 0);
      maxLagSeconds = Math.max(maxLagSeconds, rows[0]?.lag ?? 0);
    } catch {
      // amostragem é best-effort
    }
  }, 500);

  const metricsBefore = await scrapeMetrics();

  async function oneRequest(): Promise<void> {
    let key: string;
    let body: unknown;
    let kind: Sample['kind'];

    if (sent.length > 0 && Math.random() < REPLAY_RATIO) {
      const previous = sent[Math.floor(Math.random() * sent.length)]!;
      key = previous.key;
      body = previous.body;
      kind = 'REPLAY';
    } else {
      const wallet = Math.random() < HOT_RATIO ? hot : cold[Math.floor(Math.random() * cold.length)]!;
      kind = Math.random() < 0.75 ? 'BET' : 'WIN';
      const externalTransactionId = `load-${uuid()}`;
      key = `provider-a:${externalTransactionId}`;
      body = {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: `round-${uuid()}`,
        gameId: 'fortune-chimp',
        kind,
        money: { amount: kind === 'BET' ? '1.00' : '0.50', currency: 'BRL' },
      };
      if (sent.length < 5_000) sent.push({ key, body });
    }

    const startedAt = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...bearer(providerToken) },
        body: JSON.stringify(body),
      });
      await res.arrayBuffer();
      samples.push({ latencyMs: performance.now() - startedAt, status: res.status, kind });
    } catch {
      networkErrors++;
      samples.push({ latencyMs: performance.now() - startedAt, status: 0, kind });
    }
  }

  console.log(`load: ${CONCURRENCY} concurrent virtual users for ${DURATION_S}s ...`);
  const startedAt = performance.now();
  const deadline = startedAt + DURATION_S * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < deadline) await oneRequest();
    }),
  );
  const elapsedS = (performance.now() - startedAt) / 1000;
  const metricsAfter = await scrapeMetrics();

  // Drenagem da outbox (workers publicando)
  const drainStartedAt = performance.now();
  let drainSeconds: number | null = null;
  while (performance.now() - drainStartedAt < 120_000) {
    const rows = (await conn.execute(
      `select count(*)::int as n from outbox_messages where published_at is null`,
    )) as { n: number }[];
    if ((rows[0]?.n ?? 0) === 0) {
      drainSeconds = (performance.now() - drainStartedAt) / 1000;
      break;
    }
    await Bun.sleep(250);
  }
  clearInterval(sampler);

  // Prova de consistência
  console.log('verifying consistency ...');
  let inconsistent = 0;
  for (const w of allWallets) {
    const res = await post(`/wallets/${w.walletId}/reconciliation`, {}, bearer(backofficeToken));
    if (!res.body?.consistent) inconsistent++;
  }
  const globalDivergent = (
    (await conn.execute(
      `select count(*)::int as n from wallets w
        where w.balance <> coalesce((select sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end)
                                       from wallet_ledger_entries l where l.wallet_id = w.id), 0)`,
    )) as { n: number }[]
  )[0]?.n ?? 0;

  await orm.close(true);

  // ---------- análise

  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const byStatus = samples.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  const ok = samples.filter((s) => s.status === 200 || s.status === 202 || s.status === 422).length;
  const errors = samples.length - ok;
  const replays = samples.filter((s) => s.kind === 'REPLAY');
  const replayLatencies = replays.map((s) => s.latencyMs).sort((a, b) => a - b);

  const lockWaitCount = metricSum(metricsAfter, 'wallet_lock_wait_seconds_count') - metricSum(metricsBefore, 'wallet_lock_wait_seconds_count');
  const lockWaitSum = metricSum(metricsAfter, 'wallet_lock_wait_seconds_sum') - metricSum(metricsBefore, 'wallet_lock_wait_seconds_sum');
  const lockConflicts = metricSum(metricsAfter, 'wallet_lock_conflicts_total') - metricSum(metricsBefore, 'wallet_lock_conflicts_total');
  const lockWaitP95 = histogramQuantile(metricsBefore, metricsAfter, 'wallet_lock_wait_seconds', 0.95);

  const cpus = os.cpus();
  const report = {
    environment: {
      date: new Date().toISOString(),
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
      bun: Bun.version,
      target: BASE_URL,
    },
    methodology: {
      model: 'closed loop',
      concurrency: CONCURRENCY,
      durationSeconds: DURATION_S,
      wallets: { hot: 1, cold: COLD_WALLETS, hotTrafficRatio: HOT_RATIO },
      mix: { replayRatio: REPLAY_RATIO, bet: 0.75, win: 0.25 },
    },
    results: {
      requests: samples.length,
      throughputRps: Number((samples.length / elapsedS).toFixed(1)),
      latencyMs: {
        p50: Number(percentile(latencies, 50).toFixed(1)),
        p95: Number(percentile(latencies, 95).toFixed(1)),
        p99: Number(percentile(latencies, 99).toFixed(1)),
        max: Number((latencies.at(-1) ?? 0).toFixed(1)),
      },
      replayLatencyMs: {
        p50: Number(percentile(replayLatencies, 50).toFixed(1)),
        p95: Number(percentile(replayLatencies, 95).toFixed(1)),
      },
      statusCodes: byStatus,
      errorRate: Number(((errors / Math.max(1, samples.length)) * 100).toFixed(2)),
      networkErrors,
      concurrency: {
        lockAcquisitions: lockWaitCount,
        avgLockWaitMs: lockWaitCount > 0 ? Number(((lockWaitSum / lockWaitCount) * 1000).toFixed(2)) : 0,
        p95LockWaitMsUpperBound: lockWaitP95 === null ? null : lockWaitP95 * 1000,
        lockConflicts,
      },
      outbox: {
        maxPendingDuringLoad: maxPending,
        maxLagSeconds: Number(maxLagSeconds.toFixed(2)),
        drainSecondsAfterLoad: drainSeconds === null ? 'did not drain in 120s' : Number(drainSeconds.toFixed(2)),
      },
      consistency: {
        walletsReconciled: allWallets.length,
        inconsistentWallets: inconsistent,
        globalLedgerDivergences: globalDivergent,
      },
    },
  };

  const r = report.results;
  const md = `# Load test — ${report.environment.date}

## Environment
| | |
|---|---|
| OS | ${report.environment.os} |
| CPU | ${report.environment.cpu} (${report.environment.cores} cores) |
| Memory | ${report.environment.memoryGb} GB |
| Bun | ${report.environment.bun} |
| Target | ${report.environment.target} |

## Methodology
Closed loop: ${CONCURRENCY} concurrent virtual users for ${DURATION_S}s. 1 hot wallet receiving ${HOT_RATIO * 100}% of traffic + ${COLD_WALLETS} cold wallets. ${REPLAY_RATIO * 100}% of requests are idempotent replays; the rest is 75% BET / 25% WIN.

## Results
| Metric | Value |
|---|---|
| Requests | ${r.requests} |
| Throughput | ${r.throughputRps} req/s |
| Latency p50 / p95 / p99 / max | ${r.latencyMs.p50} / ${r.latencyMs.p95} / ${r.latencyMs.p99} / ${r.latencyMs.max} ms |
| Replay latency p50 / p95 | ${r.replayLatencyMs.p50} / ${r.replayLatencyMs.p95} ms |
| Error rate | ${r.errorRate}% (network errors: ${r.networkErrors}) |
| Status codes | ${Object.entries(r.statusCodes).map(([k, v]) => `${k}: ${v}`).join(', ')} |
| Avg wallet lock wait | ${r.concurrency.avgLockWaitMs} ms (p95 ≤ ${r.concurrency.p95LockWaitMsUpperBound ?? 'n/a'} ms) |
| Lock conflicts (deadlock / timeout / unique race) | ${r.concurrency.lockConflicts} |
| Outbox: max pending / max lag | ${r.outbox.maxPendingDuringLoad} / ${r.outbox.maxLagSeconds}s |
| Outbox drain after load | ${r.outbox.drainSecondsAfterLoad}s |
| Inconsistent wallets after load | ${r.consistency.inconsistentWallets} / ${r.consistency.walletsReconciled} |
| Global ledger divergences | ${r.consistency.globalLedgerDivergences} |
`;

  await mkdir('load-test-results', { recursive: true });
  const stamp = report.environment.date.replace(/[:.]/g, '-');
  await Bun.write(`load-test-results/${stamp}.json`, JSON.stringify(report, null, 2));
  await Bun.write(`load-test-results/${stamp}.md`, md);

  console.log(md);
  console.log(`report saved to load-test-results/${stamp}.{md,json}`);

  if (inconsistent > 0 || globalDivergent > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});