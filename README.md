# Jungle Wallet

Distributed financial service that processes wagering transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) received from multiple game providers, via HTTP and via AWS SQS, keeping the materialized balance and the immutable ledger consistent even with duplicated, out-of-order, and concurrent messages and process failures. Providers authenticate via OIDC (Keycloak).

> Technical decisions, trade-offs, and limitations are in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Stack

| Item | Choice |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Language | TypeScript (strict) |
| Framework | NestJS |
| Database | PostgreSQL 17 |
| ORM | MikroORM (`EntitySchema`, domain without decorators) |
| Messaging | AWS SQS FIFO via [MiniStack](https://ministack.org) |
| Identity Provider | Keycloak 26 (OIDC, *client credentials*), JWT validated with `jose` |
| Observability | pino (JSON logs), prom-client (Prometheus metrics) |
| Local orchestration | Docker Compose |

> **Why MiniStack and not LocalStack?** Since version 2026.03.0, LocalStack requires an auth token to start. MiniStack is a compatible open-source alternative on port 4566, with no account or token — and it is mentioned in the assignment itself.

## Prerequisites

- [Bun](https://bun.sh) 1.x
- Docker with Docker Compose

## Quick start

### Option A — full stack in Docker (API + 3 workers + Keycloak)

```bash
bun install
bun run stack:up        # build + postgres + ministack + keycloak + migrations + queues + api + 3 workers
docker compose ps       # api and workers should show as healthy
curl http://localhost:3000/health/ready
```

The one-shot `setup` container applies the migrations and creates the queues before the API and workers start. Keycloak imports the `jungle` realm on boot and takes 30 to 60s to become ready. In this mode the API **requires a token** (see [Authentication](#authentication)). To tear it down: `bun run stack:down`.

### Option B — local development (processes on the host, infra in Docker)

```bash
bun install
cp .env.example .env    # Windows: copy .env.example .env
bun run infra:up        # postgres (port 5433) + ministack (port 4566) + queue creation
bun run migration:up
bun run start:api       # http://localhost:3000
bun run start:worker    # another terminal — http://localhost:3001 (/health, /metrics)
```

`.env.example` ships with `AUTH_MODE=disabled`, to develop without a token. To test authentication locally: `bun run auth:up` and `AUTH_MODE=keycloak` in `.env`.

## Scripts

| Script | What it does |
|---|---|
| `infra:up` / `infra:down` | Starts/stops only Postgres and MiniStack (and creates the queues) |
| `auth:up` | Starts only Keycloak |
| `stack:up` / `stack:down` | Starts/stops the full stack, with 3 workers and Keycloak |
| `migration:up` / `migration:down` | Applies/reverts migrations (versioned and reversible) |
| `sqs:setup` | Creates the queues (idempotent) |
| `start:api` / `dev:api` | Starts the API (`dev` with watch) |
| `start:worker` | Starts the worker (SQS consumer, outbox publisher, references worker) |
| `typecheck` | `tsc --noEmit` in strict mode |
| `test:unit` | Unit tests |
| `test:integration` | Integration tests against real Postgres and SQS |
| `test:concurrency` | Tests with multiple real worker processes |
| `test:load` | Load test against the full stack |

## Authentication

The `jungle` realm (imported from `docker/keycloak/realm-jungle.json`) has three clients using the *client credentials* flow:

| Client | Secret | Claim `provider_id` | Can |
|---|---|---|---|
| `provider-a` | `provider-a-secret` | `provider-a` | submit and query transactions as `provider-a` |
| `provider-b` | `provider-b-secret` | `provider-b` | submit and query transactions as `provider-b` |
| `backoffice` | `backoffice-secret` | — | create and query wallets, reconciliation |

Get a token (valid for 5 minutes):

```bash
curl -s -X POST http://localhost:8080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret
```

Send it in the `Authorization: Bearer <access_token>` header. No token or an invalid token → `401`. A provider trying to act as another, or the backoffice submitting a wager → `403`. `/health` and `/metrics` are public. The SQS queue is a trusted internal channel and does not require a token.

### Postman collection

`postman/jungle-wallet.postman_collection.json` contains all endpoints organized in folders (tokens, wallets, happy path, rejections, out-of-order reference, security), with tokens and ids saved automatically by scripts. Run the folders in order, starting with `00 - Auth`.

## Tests

No test replaces PostgreSQL or SQS with mocks: integration and concurrency tests run against the real containers.

```bash
bun run typecheck
bun run test:unit
bun run infra:up && bun run migration:up
bun run test:integration
bun run test:concurrency
```

> **Important:** the integration and concurrency suites run **with the infra only** (`infra:up`). If the full stack is running, its workers consume the same queues and publish the same outbox that the tests observe. The suite detects this and aborts with a message; to fix it: `docker compose stop api worker`. Unit tests do not depend on infra.

The authentication tests (`test/integration/auth.spec.ts`) exercise the `keycloak` mode **without starting Keycloak**: the test generates an RSA key pair and serves a local JWKS.

### Concurrency suite on Linux (includes the SIGTERM test)

The SIGTERM test is skipped on Windows, which does not have that signal (the process is terminated directly). To run the full suite in a Linux container, with the stack up and the workers stopped:

```bash
bun run stack:up
docker compose stop worker
docker compose run --rm -e NODE_ENV=test api bun run test:concurrency
```

### What the concurrency suite proves

| Scenario | Verified result |
|---|---|
| 3 processes on a hot wallet (150 bets of 10.00 against 1000.00, each message delivered 2×) | exactly 100 processed, 50 rejected, balance 0.00, 101 entries |
| Distinct wallets in parallel across 3 processes | all with correct balance and ledger |
| Worker killed **after commit and before ack** (fault injection) | redelivery lands in the inbox, debit is not duplicated |
| SIGKILL on all instances mid-processing | after restart, consistent final state |
| 3 outbox publishers in different processes | each event published exactly once |
| SIGTERM during processing | drains in-flight work; nothing is lost after restart |

Invariant checked at the end of **all** integration and concurrency tests: `wallet.balance == balance rebuilt from the ledger`, for every wallet in the database.

## Load test

```bash
bun run stack:up
bun run test:load
```

The script obtains tokens from Keycloak (`backoffice` to create wallets, `provider-a` for the transactions); without Keycloak, it proceeds without a token. Optional variables: `LOAD_CONCURRENCY` (50), `LOAD_DURATION_S` (30), `LOAD_WALLETS` (50), `LOAD_HOT_RATIO` (0.2). The full report (environment, methodology, results) is saved in `load-test-results/`.

Reference result, with authentication enabled (50 concurrent users, 30s, 20% of traffic on a hot wallet, i5-1145G7 4C/8T laptop, Windows + Docker Desktop):

| Metric | Value |
|---|---|
| Throughput | 116.8 req/s |
| Latency p50 / p95 / p99 | 381 / 679 / 893 ms |
| Error rate | 0% |
| Average wallet lock wait | 38.5 ms |
| Outbox: max lag / drain after load | 1.03 s / 0.51 s |
| Inconsistent wallets after load | 0 of 51 |

The full analysis — including the measurement-driven publisher optimization, which reduced outbox lag by ~10×, and the cost of authentication — is in [ARCHITECTURE.md](./ARCHITECTURE.md#17-load-test).

## API

| Method | Route | Token | Description |
|---|---|---|---|
| `POST` | `/wallets` | any client | Creates a wallet (initial balance generates an `OPENING` transaction + entry) |
| `GET` | `/wallets/:walletId` | any client | Gets a wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | any client | Paginated ledger with an opaque, stable cursor |
| `POST` | `/wallets/:walletId/reconciliation` | any client | Compares the materialized balance with the ledger |
| `POST` | `/wagering/transactions` | provider in the body | Submits a transaction (`Idempotency-Key` header required) |
| `GET` | `/wagering/transactions/:transactionId` | any client | Lookup by internal id |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | provider in the path | Lookup by provider id |
| `GET` | `/health/live` / `/health/ready` | public | Liveness / readiness (Postgres and SQS) |
| `GET` | `/metrics` | public | Prometheus metrics |

### Example

```bash
TOKEN_BO=$(curl -s -X POST http://localhost:8080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=backoffice -d client_secret=backoffice-secret | jq -r .access_token)
TOKEN_A=$(curl -s -X POST http://localhost:8080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)

curl -s -X POST http://localhost:3000/wallets \
  -H "authorization: Bearer $TOKEN_BO" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<id returned above>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

HTTP status: `200` processed (new or replay) · `202` awaiting reference · `422` rejected by business rule · `400` invalid payload · `401` no valid token · `403` provider not authorized · `404` not found · `409` idempotency conflict · `503` transient failure. Details in [ARCHITECTURE.md](./ARCHITECTURE.md#12-http-status-mapping).

### SQS message (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

## Observability

- **Logs:** single-line JSON (pino), with `correlationId`, `messageId`, `transactionId`, `walletId`, and `providerId` attached automatically. Request bodies are never logged; credentials and financial fields are masked.
- **Metrics:** `GET /metrics` on the API (3000) and on the worker (3001). See the list in [ARCHITECTURE.md](./ARCHITECTURE.md#15-observability).
- **Health:** `/health/live` (process alive) and `/health/ready` (Postgres and SQS reachable).

## Structure

```
src/
├── main.api.ts / api.module.ts         # composition root of the API process
├── main.worker.ts / worker.module.ts   # composition root of the worker process
├── worker.lifecycle.ts                 # starts the loops and drains on SIGTERM
├── config/                             # validated env, CoreModule (ORM, repositories, runner)
├── shared/                             # Money, errors, events, ports, cross-cutting infra
└── modules/
    ├── wallet/                         # Wallet, ledger, opening, queries, reconciliation
    ├── wagering/                       # WagerTransaction, rules, use cases, HTTP, consumer, worker
    ├── messaging/                      # Inbox, Outbox, publisher
    ├── health/
    └── auth/                           # global guard, JWT validation (Keycloak), provider rule
migrations/                             # schema, constraints, indexes, and triggers
docker/keycloak/                        # realm imported on boot
postman/                                # collection with all endpoints
test/{unit,integration,concurrency,load}
```

Each module follows `domain/` (no framework dependency) → `application/` (use cases and ports) → `infrastructure/` (adapters: persistence, HTTP, SQS).