# Architecture

This document records the technical decisions, trade-offs and known limitations. The order follows the challenge's evaluation areas.

## Table of contents

1. [Overview](#1-overview)
2. [Authentication](#2-authentication)
3. [ORM and transaction strategy](#3-orm-and-transaction-strategy)
4. [Money](#4-money)
5. [Domain model](#5-domain-model)
6. [Database schema guarantees](#6-database-schema-guarantees)
7. [Concurrency](#7-concurrency)
8. [Idempotency](#8-idempotency)
9. [Business rules and interpretations](#9-business-rules-and-interpretations)
10. [Out-of-order references](#10-out-of-order-references)
11. [failureCode taxonomy](#11-failurecode-taxonomy)
12. [HTTP status mapping](#12-http-status-mapping)
13. [Messaging: consumer, inbox and outbox](#13-messaging-consumer-inbox-and-outbox)
14. [Integration events](#14-integration-events)
15. [Observability](#15-observability)
16. [Tests](#16-tests)
17. [Load test](#17-load-test)
18. [Limitations and next steps](#18-limitations-and-next-steps)

---

## 1. Overview

```
                   ┌───────────┐
                   │ Keycloak  │  (JWKS: signing keys)
                   └─────┬─────┘
                         │
                  ┌──────┴───────────────┐
  HTTP + JWT ────▶│  API (main.api.ts)   │──┐
                  └──────────────────────┘  │      ┌──────────────┐
                                            ├─────▶│  PostgreSQL  │
  SQS                ┌───────────────────┐  │      │ wallets      │
  wager-transactions │ Worker ×N         │──┘      │ ledger       │
  .fifo ────────────▶│ (main.worker.ts)  │         │ transactions │
                     │ • consumer        │         │ inbox/outbox │
                     │ • outbox publisher│         └──────────────┘
                     │ • pending refs    │
                     └─────────┬─────────┘
                               │ SendMessageBatch
                               ▼
                    SQS wallet-events.fifo
```

There are **two processes** with separate composition roots (`api.module.ts` and `worker.module.ts`), independently scalable (`docker compose up --scale worker=3`). Both call **the same** `ProcessWagerTransaction`: there is a single business rule, and only the input adapter changes.

Each module follows three layers:

- **`domain/`** — entities, value objects, rules and ports. No NestJS, no ORM.
- **`application/`** — use cases, transactional orchestration, infrastructure ports.
- **`infrastructure/`** — adapters: persistence (MikroORM), HTTP (controllers + zod), SQS.

## 2. Authentication

**Implemented with Keycloak (OIDC), integrated as an external Identity Provider.** There is no users table and no hand-rolled authentication.

**Provider identity.** The `jungle` realm (imported at boot from `docker/keycloak/realm-jungle.json`) has one client per provider (`provider-a`, `provider-b`) and a `backoffice` client, all using the *client credentials* flow — the machine-to-machine flow, suited to system-to-system integrations. Two mappers per client: a hardcoded one that adds the **`provider_id`** claim to the access token (only on provider clients) and an audience one that includes **`wallet-api`** in `aud`.

**Local JWT validation.** The API does not call Keycloak on every request. The `JwtProviderIdentity` adapter validates the token with the `jose` lib: RS256 signature against the realm's JWKS (fetched once and cached, with automatic refresh on key rotation), `iss`, `aud` and `exp`. Failure to fetch the keys is treated as an **infrastructure failure (503)**, not as invalid credentials (401).

**Where each rule lives:**

- `ProviderIdentityPort` — the port. Two adapters: `JwtProviderIdentity` (`AUTH_MODE=keycloak`) and `DisabledProviderIdentity` (`AUTH_MODE=disabled`, for local development and tests that are not about auth). The mode is read at bootstrap.
- `AuthGuard` — **global guard** (`APP_GUARD`). Requires a valid identity on every route not marked with `@Public()` (marked: `/health` and `/metrics`) and stores the identity on the request.
- `assertProviderAccess` — **domain validation at the HTTP edge.** On `POST /wagering/transactions`, the body's `providerId` must equal the token's `provider_id`; on `GET /providers/:providerId/...`, the path's one. Otherwise, **403**. A provider does not act on behalf of another, and the backoffice does not submit bets.

**Why two Keycloak addresses.** The token is issued to whoever requests it at `localhost:8080` (the `iss` is `http://localhost:8080/realms/jungle`), but the API runs inside the Docker network, where `localhost` is the container itself. That is why the configuration separates `OIDC_ISSUER` (validated in the token) from `OIDC_JWKS_URL` (where the keys are fetched from, `http://keycloak:8080/...`).

**SQS queue.** Treated as a trusted internal channel, as the spec defines: the worker does not require a token. The provider identity contained in the message goes through the same domain validations, because the use case is the same.

**Testing without Keycloak.** `test/integration/auth.spec.ts` starts the API in `keycloak` mode, but generates an RSA key pair in the test itself and serves a local JWKS. It covers valid, missing and expired tokens, tokens signed by another key, with wrong audience or issuer, a provider acting as another, the backoffice submitting a bet, and public routes.

## 3. ORM and transaction strategy

**MikroORM**, the spec's preferred option.

**Mapping:** `EntitySchema` over plain `*Record` classes, and mappers that convert record ⇄ domain via `rehydrate`. The domain does not know the ORM: private constructors, no decorators — requirements of the spec that would conflict with directly annotated entities.

**Transaction:** a `TransactionRunner` port whose implementation does `em.fork().transactional(...)`. MikroORM registers the fork in the `TransactionContext` (AsyncLocalStorage), so the repositories use the injected `EntityManager` and automatically join the current transaction, without receiving the transaction as a parameter. The runner also translates driver exceptions into application errors (`UniqueConstraintConflictError`, `TransientInfrastructureError`), and the application layer does not know the ORM.

**No ORM relations between aggregates.** Aggregates reference each other by id (DDD). Since the ORM then cannot infer the INSERT order from the FKs, the repositories do an explicit `flush` on each `add`/`save`, within the same transaction. The order becomes deterministic (transaction → ledger → wallet → outbox) and atomicity is preserved.

**Accepted trade-off:** the record/mapper split doubles the persistence code and gives up part of the Unit of Work and Identity Map in the domain — which are precisely MikroORM's selling points. In return, the domain is testable without a database and shielded from persistence details. The per-operation flush also costs round-trips (see [§17](#17-load-test)).

## 4. Money

- Internal value in **`decimal.js`** (cloned instance, isolated from global configuration). `number` is never used for money in any layer.
- **Strict contract:** `amount` is a string with **exactly 2 decimal places** (`"25.00"`), no sign, no scientific notation, up to 17 integer digits (the `numeric(19,2)` limit). `"25"` and `"25.5"` are rejected: the spec defines a fixed scale, and the regex is the only thing to change if it needs loosening.
- **Nothing is rounded.** An input with 3 decimal places is rejected, never silently rounded: altering the amount sent by a provider is worse than refusing it.
- Immutable: every operation returns a new instance. Operations between different currencies throw `CurrencyMismatchError`; `equals` between different currencies returns `false`.
- `from()` rejects negatives (input contract), but `subtract()` can produce a negative internally — needed, for example, for the difference in reconciliation. What prevents a negative balance is the `Wallet` and the database `CHECK`.
- **Persistence:** `numeric(19,2)` + a `currency char(3)` column. The `pg` driver returns `numeric` as a string (`"975.00"`), so the value goes from the database to `Money.from` without passing through `number`.
- The challenge assumes a single currency (BRL), but the model is multi-currency and currency conflicts are tested.

## 5. Domain model

All classes follow **private constructor + factories** (`create`/`open`/`from`), and `rehydrate` rebuilds the persisted state **without revalidating transitions**.

- **`Wallet`** (aggregate root): `debit`/`credit` **return the `WalletLedgerEntry`**. There is no way to change the balance without receiving the corresponding entry. The entry is created **before** mutating the wallet: if validation fails, the wallet stays intact. `version` starts at 1 and only increments when the balance changes. `canDebit()` separate from `debit()` lets wagering choose the correct `failureCode` depending on the context.
- **`WalletLedgerEntry`:** `readonly` fields and `Object.freeze` in the constructor — structural immutability at runtime, not just at compile time. `create` validates the arithmetic (`balanceBefore ± money === balanceAfter`).
- **`WagerTransaction`:** encapsulated state, explicit transitions.
- **`evaluateReference`:** a pure function that applies the reference rules from section 7 of the spec and returns `accept`, `wait` or `reject` with a code. Fetching the reference from the database is the use case's job; the rule is unit-tested, with one case per `failureCode` (`test/unit/reference-policy.spec.ts`).

**Two kinds of error:**

- `DomainError` — business or contract path, always with a `failureCode`.
- `InvariantViolationError` — programming error (impossible state, transition from a terminal state). No `failureCode`, becomes a 500.

### `WagerTransaction` transitions

| From | To |
|---|---|
| `PENDING` | `PROCESSED`, `PENDING_REFERENCE`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` (and attempt rescheduling, without changing status) |
| `PROCESSED` / `REJECTED` / `FAILED` | none — `InvalidTransactionStateError` |

The same rules are enforced in the database by the `wager_tx_guard_update` trigger.

Signature adaptations relative to the spec's skeletons: `markProcessed` and `reject` also receive the observed balance (the replay needs to return it, including for `LOSS` and `REJECTED`, which have no entry), and `WalletLedgerEntry` carries `walletVersion`, which gives the immutable per-wallet sequence.

## 6. Database schema guarantees

The spec requires uniqueness, immutability and non-negativity to be enforced **in the schema**, not just in code. The schema is deliberately strict: the application is the first barrier, and the database is the last.

| Guarantee | Mechanism |
|---|---|
| Balance never negative | `CHECK (balance >= 0)` on `wallets` and on the ledger balances |
| One wallet per player + currency | `UNIQUE (player_id, currency)` |
| Persistent idempotency | `UNIQUE (provider_id, idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)` |
| Transaction belongs to the declared wallet, player and currency | Composite FK `(wallet_id, player_id, currency) → wallets` |
| Entry in the same currency/wallet as the transaction | Composite FK `(transaction_id, wallet_id, currency) → wager_transactions` |
| At most one entry per transaction | `UNIQUE (transaction_id)` on the ledger |
| No lost update | `UNIQUE (wallet_id, wallet_version)` on the ledger |
| Entry arithmetic | `CHECK` of `balance_before ± amount = balance_after` |
| Immutable ledger | trigger that blocks `UPDATE`/`DELETE` |
| Chained ledger | trigger: `balance_before` of entry N = `balance_after` of N-1 |
| Balance ⇔ ledger (both directions) | `DEFERRABLE INITIALLY DEFERRED` constraint triggers, checked at commit |
| Immutable terminal states | `wager_tx_guard_update` trigger (also blocks changes to business columns) |
| `OPENING` internal only | `CHECK ((kind = 'OPENING') = (provider_id = '__system__'))` |
| Single reversal | partial unique index on `reference_transaction_id` for `PROCESSED` reversals |
| Reference required/forbidden per kind | `CHECK`s per `kind` |
| `failureCode` consistent with status | `CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL))` |

**Why deferred constraint triggers?** Within a transaction, the wallet and the entry are written in sequence; an immediate check would fail on the intermediate state. Deferred, it evaluates the final state at commit: if the wallet balance does not match the `balance_after` of the current version's entry, **the whole commit is refused**.

**First-entry rule:** a wallet opened with a zero balance starts at `version = 1` with no entry, and its first movement produces `walletVersion = 2`. The chaining trigger accepts as the first entry version 1 (opening with a balance) or 2 (first movement of a wallet opened with zero), always with `balance_before = 0`. This case was found by an integration test — an example of a mismatch between domain and schema that fails loudly instead of passing silently.

Migrations are versioned, written in explicit SQL and reversible (`up`/`down`), verified with a full `down` followed by `up`.

## 7. Concurrency

**The unit of concurrency is the `walletId`.**

**Strategy: pessimistic lock per wallet** (`SELECT ... FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`), inside the transaction, before any rule read. Everything that touches a wallet is serialized; different wallets run in parallel. There is no global lock.

**Why pessimistic and not optimistic?**

- Hot wallets (a very active player) are the normal case in iGaming. With optimistic locking, every conflict becomes a retry: under high contention, retries multiply and tail latency explodes, with the risk of exhausting the attempt limit.
- With pessimistic locking, contention becomes a **queue** in the database: deterministic behavior, no retry in the application and no "attempts exhausted" path for a valid operation.
- The cost is per-wallet serialization, which is exactly the correct semantics for a balance.

`version` keeps incrementing (required by the spec), and `UNIQUE (wallet_id, wallet_version)` works as a lost-update detector in the database, regardless of the locking strategy.

**Fixed lock order — wallet first.** The pending-reference worker discovers the wallet in a read without a lock and, in a second transaction, locks the wallet before re-reading the transaction. With the order always the same, there is no wait cycle (deadlock).

**Required scenario (section 8):** balance 100.00, two simultaneous bets of 80.00. The second transaction waits for the lock; when it gets it, it reads the already-debited balance (20.00) and rejects with `INSUFFICIENT_FUNDS`. Result: one `PROCESSED`, one `REJECTED`, balance 20.00, one debit entry. Covered in `test/integration/wagering.spec.ts`, and at scale with 3 processes in `test/concurrency/processes.spec.ts`.

**Multiple instances:** correctness does not depend on anything in memory. The lock, idempotency, the inbox and the outbox claim live in Postgres, so N instances behave like one. Tested with 3 real processes.

## 8. Idempotency

- The **`Idempotency-Key` header is mandatory and is the source of truth**. The scope is `(providerId, idempotencyKey)`, protected by a `UNIQUE` in the database.
- **`payloadHash`** = SHA-256 (hex) of the **canonical JSON** — keys sorted recursively, `undefined` omitted — of the subset of business fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`. Header, `correlationId` and transport metadata are left out.
- **Same key + same hash →** replay: returns the original result (same `transactionId`, status and **balance observed at that moment**, stored in `observed_balance`) with `idempotentReplay: true`. The HTTP status is the same as the original.
- **Same key + different hash →** `409 IDEMPOTENCY_CONFLICT`. The same `externalTransactionId` with another key is also a conflict.
- **The check happens after the wallet lock.** As a result, 50 identical simultaneous requests are serialized: the first one processes, the other 49 find the transaction already stored and become replays. Covered by the test "the same bet sent 50 times in parallel → a single debit".
- **Backstop:** if two requests with the same key but a different `walletId` run together (different locks), one hits the `UNIQUE`. The use case retries once, and the second attempt becomes a replay or a conflict.
- **SQS:** in addition to the key, a **persistent inbox** per `(consumerName, messageId)`, written in the same transaction as the effects. A repeated `messageId` only becomes a replay if the content is identical: the inbox stores the `payload_hash`, and a `messageId` reused with different content is a **conflict** (goes to the DLQ with `IDEMPOTENCY_CONFLICT`), never a silent replay. No guarantee depends on an in-memory cache or on SQS FIFO deduplication.

## 9. Business rules and interpretations

| Topic | Adopted interpretation | Reason |
|---|---|---|
| Single reversal | A transaction can be reversed **only once, by any type** (`REFUND` or `ROLLBACK`) | The spec says "same type", but allowing `REFUND` and `ROLLBACK` on the same `BET` would credit twice. A `ROLLBACK` of a `REFUND` is still possible, since it references another transaction |
| Amount | `> 0` for every kind, except `LOSS` (accepts `0`) | `LOSS` only records the outcome |
| `WIN` | Optional reference; if provided, it must point to a `BET` in the same scope | "May reference" in the spec |
| Reference scope | Same provider, player, wallet, currency and round | Section 7 of the spec |
| Reference still pending | If the reference exists but is also `PENDING_REFERENCE`, the transaction **waits** (it is not rejected) | E.g.: `ROLLBACK` of a `REFUND` that is still waiting for its `BET` |
| Reversal without balance | `REJECTED` with `REVERSAL_WOULD_OVERDRAW`, distinct from `INSUFFICIENT_FUNDS` | Required by the spec: they are operationally different situations |
| Contract errors | Nonexistent wallet, player from another wallet, different currency and invalid payload **are not persisted** as `REJECTED` | The composite FK prevents storing a transaction with a player/currency different from the wallet's. `REJECTED` is reserved for business rules on a valid transaction |
| `OPENING` | Reserved provider `__system__`, `externalTransactionId = opening:{walletId}` | Cannot be submitted via API or queue (validated in the use case and in the database) |
| `amount` format | Exactly 2 decimal places | "Fixed scale of 2 decimal places" in the spec |
| `FAILED` status | Exists in the model, the schema and the transitions, but no current flow reaches it. Permanent infrastructure failures are recorded in the **DLQ** (reason, detail and attempts in the attributes), not in the transaction | The typical permanent failure (database unavailable) is precisely what prevents storing the transaction. Persisting `FAILED` would require a second write after the database came back, with no audit gain over the DLQ |

## 10. Out-of-order references

- Missing reference → `PENDING_REFERENCE`, `WagerTransactionPendingReference` event and scheduling of the next attempt.
- A scheduled worker (`PendingReferenceWorker`) fetches due transactions and reprocesses each one in its own transaction, with the same `WagerTransactionProcessor` used for new input. Two workers on the same item are safe: the second one locks the wallet, re-reads the state and skips if it has already been resolved or rescheduled.
- **Policy:** up to 10 reschedules with exponential backoff — intervals of 1s, 2s, 4s… doubling up to a 5min cap, for a total of 11 reprocessings by the worker and **≈18.5 minutes** (1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 300 + 300 = 1,111s). Configurable via env (`REFERENCE_RETRY_*`).
- **Rationale:** out-of-order delivery comes from races between messages, which resolve within seconds. A reference that has not arrived in ~18 minutes is unlikely to arrive, and waiting longer only delays feedback to the provider.
- Limit exhausted → `REJECTED` with `REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event.

## 11. failureCode taxonomy

Stable, machine-readable codes, enough for the provider to decide whether to resend, fix or give up.

| failureCode | Where it appears | Provider action |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `REJECTED` (422) | Give up; the bet is not accepted |
| `REVERSAL_WOULD_OVERDRAW` | `REJECTED` (422) | Escalate operationally: legitimate reversal without balance |
| `REFERENCE_NOT_FOUND` | `REJECTED` (422), after exhausting the attempts | Check whether the referenced transaction was sent |
| `REFERENCE_MISMATCH` | `REJECTED` (422) | Fix the reference (different scope) |
| `REFERENCE_KIND_NOT_ALLOWED` | `REJECTED` (422) | Fix: e.g. `REFUND` of something that is not a `BET` |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` (422) | The reference was rejected; nothing to reverse |
| `REFERENCE_ALREADY_REVERSED` | `REJECTED` (422) | Give up; already reversed |
| `REVERSAL_AMOUNT_MISMATCH` | `REJECTED` (422) | Fix the amount (partial reversal out of scope) |
| `INVALID_PAYLOAD` / `INVALID_MONEY` | error 400 | Fix the payload |
| `CURRENCY_MISMATCH` / `WALLET_PLAYER_MISMATCH` | error 400 | Fix the payload |
| `UNAUTHENTICATED` | error 401 + `WWW-Authenticate: Bearer` | Obtain a valid token and resend |
| `FORBIDDEN` | error 403 | Do not resend: the client cannot act as that provider |
| `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | error 404 | Check the ids |
| `IDEMPOTENCY_CONFLICT` | error 409 | Do not resend with the same key: the payload diverged |
| `WALLET_ALREADY_EXISTS` | error 409 | Use the existing wallet |
| `TRANSIENT_INFRASTRUCTURE_ERROR` | error 503 + `Retry-After` | **Resend with the same key** |
| `PERMANENT_INFRASTRUCTURE_ERROR` | `FAILED` status (reserved, see [§9](#9-business-rules-and-interpretations)) | Auditable; investigate |
| `INTERNAL_ERROR` | error 500 | Report |

## 12. HTTP status mapping

Same code for the same situation, across all endpoints.

| Situation | HTTP | Body |
|---|---|---|
| Processed (new or replay) | **200** | `WagerResult` |
| Accepted, awaiting reference | **202** | `WagerResult` (`PENDING_REFERENCE`) |
| Rejected by business rule | **422** | `WagerResult` with `failureCode` |
| Invalid payload / contract | **400** | `{ error: { code, message, retryable, details? } }` |
| No valid token | **401** + `WWW-Authenticate: Bearer` | `{ error }` |
| Client not authorized for the provider | **403** | `{ error }` |
| Nonexistent resource | **404** | `{ error }` |
| Idempotency conflict / duplicate wallet | **409** | `{ error }` |
| Transient infrastructure failure (includes IdP keys unavailable) | **503** + `Retry-After` | `{ error: { retryable: true } }` |
| Unexpected error | **500** | `{ error: { code: INTERNAL_ERROR } }` |

A business rejection returns the full `WagerResult` (`transactionId`, balance), because the transaction exists and is auditable. Contract errors return `{ error }`, because nothing was persisted. The provider tells them apart by the status **and** by the body format, without interpreting messages. A replay returns the same status as the original (a 422 stays 422). Authentication runs before body validation, so a request without a token gets 401 even with an invalid payload.

## 13. Messaging: consumer, inbox and outbox

### SQS consumer

Long polling on `wager-transactions.fifo`, calling the same use case as the API.

| Outcome | Action |
|---|---|
| Processed (including `REJECTED` and `PENDING_REFERENCE`) | **ack** — always post-commit (`execute` only returns after the commit) |
| Contract error (invalid payload, nonexistent wallet, idempotency conflict) | **Immediate DLQ**: resending does not help |
| Malformed message (JSON/envelope) | **Immediate DLQ** |
| Transient failure or unexpected error | **retry** with backoff via `ChangeMessageVisibility` (2s, 4s, 8s… 60s cap) |
| Reached `maxReceiveCount` (10) | **DLQ** with reason `RETRIES_EXHAUSTED` |

- **Application-driven DLQ:** sends to `wager-transactions-dlq.fifo` with `failureReason`, `failureDetail` and `receiveCount` in the attributes, and only then deletes from the main queue. It stays auditable and does not depend on the `RedrivePolicy` (configured anyway, as a safety net).
- **Parallelism across groups, order within a group:** each received batch is grouped by `MessageGroupId`; different groups in parallel, messages from the same group in sequence. If a message in the group is rescheduled for retry, the following ones in the same batch **are not processed**: they go back to the queue (`VisibilityTimeout = 0`), and FIFO only delivers them again after the one that failed. Without this, a `BET` with a transient failure would be overtaken by the `REFUND` that comes after it. Balance correctness would not depend on this (the `REFUND` would go to `PENDING_REFERENCE`), but the provider's order is preserved and the waiting path is not triggered unnecessarily. Cost: the returned messages also count a delivery in `ApproximateReceiveCount`.

### Retry limit and PostgreSQL unavailability

The spec asks for a retry limit before the DLQ and warns that PostgreSQL may become temporarily unavailable. The two requirements pull in opposite directions: with the database down, **every** message fails as transient, and a short limit sends valid transactions that only needed to wait to the DLQ.

**Adopted decision:** `maxReceiveCount = 10`, with a backoff of 2s doubling up to a 60s cap (2 + 4 + 8 + 16 + 32 + 60 + 60 + 60 + 60). The system tolerates **about 5 minutes** of database unavailability without DLQ, enough for a restart, a failover or a short maintenance window. The application value (`SQS_MAX_RECEIVE_COUNT`) and the queue's `RedrivePolicy` value come from the same variable, and `sqs:setup` reapplies the `RedrivePolicy` to queues that already exist.

**Trade-off:** an unexpected error that will never resolve (a bug, for example) also now takes ~5 minutes to reach the DLQ, instead of ~30s. Contract and business errors are not affected: they go straight to the DLQ or are acked on the first attempt.

**Limitation:** beyond ~5 minutes of unavailability, messages go to the DLQ with reason `RETRIES_EXHAUSTED` and need to be resent (redrive). Nothing is lost, because the DLQ keeps the message intact with the reason and the number of attempts, but manual intervention is required. The complete fix is in the next steps ([§18](#18-limitations-and-next-steps)).
- **SIGTERM:** stops fetching messages (aborts the long polling), finishes those in progress and returns the visibility (`VisibilityTimeout = 0`) of those that have not started yet. In Compose, `init: true` (tini as PID 1) forwards the signal and `stop_grace_period: 30s` gives time to drain.
- **Crash between commit and ack:** the message comes back after the visibility timeout, the inbox detects the duplicate and the result becomes a replay — no duplicate effect. Tested with a fault injection hook (`CHAOS_EXIT_BEFORE_ACK`, off by default) that kills the process exactly at that point. If the `ack` itself fails (network error), the message is rescheduled as a transient failure, with the same safe outcome.

### Inbox

Recorded with `INSERT ... ON CONFLICT DO NOTHING` **in the same transaction** as the financial change, already marked as processed: if the commit happened, the message was processed; if not, nothing exists and the redelivery reprocesses it. Two simultaneous deliveries of the same message: the second waits for the first one's commit and hits the conflict, where the `payload_hash` decides between replay and conflict ([§8](#8-idempotency)).

### Transactional Outbox

- Transaction, balance, ledger, inbox and events are written in the **same commit**. No event is published before the commit.
- **Claim with `FOR UPDATE SKIP LOCKED`:** concurrent publishers take disjoint batches. If a publisher dies midway, its transaction rolls back, the lock is released and another one takes over.
- **`outbox.id = eventId`**, used as the `MessageDeduplicationId` in SQS and as the dedup key for consumers: a republication carries the same `eventId`.
- **`MessageGroupId = aggregateId = walletId`:** a wallet's events go out in order.
- **Batch sending** (`SendMessageBatch`, 10 per call), batches in sequence to preserve order within the claim. Partial failures are handled entry by entry.
- **No retry limit:** a committed event cannot be lost (an invariant of the spec). It stays in retry with backoff (1s → 60s cap), and the `wallet_outbox_lag_seconds` metric is the alert.

## 14. Integration events

| Event | When |
|---|---|
| `WagerTransactionProcessed` | any applied transaction, including `LOSS` and `OPENING` |
| `WagerTransactionRejected` | rejection by business rule (including `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | only when the balance changes |
| `WagerTransactionPendingReference` | missing reference |

Envelope: abstract class `IntegrationEvent<T>` with one concrete subclass per event. `eventType` and `version` live in the type, not in loose strings at the call site. `data` carries `MoneyProps` (decimal string), never the `Money` instance, ensuring stable, versionable JSON. `correlationId` propagates the one from the originating request/message, and `causationId` points to the key or `messageId` that caused the event.

## 15. Observability

### Logs

- **Single-line JSON** (pino via `nestjs-pino`), with `level`, `time` (ISO), `service` (`api`/`worker`) and `msg`.
- **Automatic context:** a `LogContext` over `AsyncLocalStorage` holds `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId` while a request or message is processed, and pino injects these fields into every line via `mixin`. The `correlationId` comes from the `x-correlation-id` header (or is generated) and is returned in the response.
- **No sensitive data:** the request log records method, URL, status and time — never the body. `redact` masks `authorization` (the token), `cookie` and, defensively, `money`/`balance`. Business logs record status, kind and `failureCode`, not amounts.

### Metrics (`GET /metrics`)

| Metric | Type | What it measures |
|---|---|---|
| `wallet_transactions_total{status,source}` | counter | transactions by status and input (`http`/`sqs`/`worker`) |
| `wallet_transaction_processing_seconds{source}` | histogram | processing latency |
| `wallet_duplicates_detected_total{source}` | counter | idempotent replays and inbox duplicates |
| `wallet_retries_total{component}` | counter | consumer, outbox and reference retries |
| `wallet_dlq_messages_total{reason}` | counter | messages sent to the DLQ, by reason |
| `wallet_lock_wait_seconds` | histogram | wait for the wallet lock |
| `wallet_lock_conflicts_total{reason}` | counter | deadlock, lock timeout, uniqueness race |
| `wallet_outbox_pending` / `wallet_outbox_lag_seconds` | gauge | backlog and age of the oldest unpublished event |
| `wallet_outbox_published_total` | counter | published events |
| `wallet_reconciliation_divergences_total` | counter | wallets with a balance diverging from the ledger |

**About "lock conflicts":** with pessimistic locking, contention does not show up as an error, it shows up as waiting. That is why the main metric is `wallet_lock_wait_seconds` — a hot wallet shows up as a long tail in the histogram. The conflict counter is for the exceptional cases.

### Health checks

`/health/live` (process alive, no dependencies) and `/health/ready` (Postgres and SQS reachable, with a 2s timeout; 503 if either fails). Both public, on the API and on the worker.

### Reconciliation

`POST /wallets/:walletId/reconciliation` briefly locks the wallet, compares the materialized balance with the ledger sum and responds with the difference. A divergence is **never silently corrected**: it is logged, counted in a metric and flagged with `consistent: false`.

## 16. Tests

| Level | Where | Infra |
|---|---|---|
| Unit | `test/unit` | none |
| Integration | `test/integration` | Real Postgres and MiniStack (auth with local JWKS) |
| Concurrency | `test/concurrency` | Postgres, MiniStack and **real worker processes** (`Bun.spawn`) |
| Load | `test/load` | full stack in Docker, with Keycloak |

### Coverage of required tests

| Spec requirement | Test |
|---|---|
| Money: scale, rounding, invalid inputs | `unit/money.spec.ts` |
| Wallet invariants | `unit/wallet.spec.ts`, `unit/wallet-ledger-entry.spec.ts` |
| BET, WIN, LOSS, REFUND, ROLLBACK rules | `unit/wager-transaction.spec.ts`, `unit/reference-policy.spec.ts`, `integration/wagering.spec.ts` |
| Currency conflict | `unit/money.spec.ts`, `unit/wallet.spec.ts`, `integration/wagering.spec.ts` |
| Idempotency key with divergent payload | `integration/wagering.spec.ts` (including reused `messageId`), `integration/http.spec.ts` |
| Migrations and constraints | `integration/persistence-and-constraints.spec.ts` |
| Atomicity across wallet, ledger, inbox and outbox | `integration/wagering.spec.ts` (events written in the same commit), deferred constraints |
| Inbox and redelivery | `integration/messaging-persistence.spec.ts`, `integration/worker.spec.ts` |
| Concurrent publishers on the same outbox | `integration/messaging-persistence.spec.ts`, `concurrency/processes.spec.ts` |
| Retry and DLQ | `integration/worker.spec.ts` |
| Recovery after restart | `concurrency/processes.spec.ts` (SIGKILL on all instances) |
| Same bet 50× in parallel → one debit | `integration/wagering.spec.ts` |
| Balance contention on the same wallet (section 8) | `integration/wagering.spec.ts`, `concurrency/processes.spec.ts` |
| Distinct wallets in parallel | `integration/wagering.spec.ts`, `concurrency/processes.spec.ts` |
| ≥ 3 simultaneous processes | `concurrency/processes.spec.ts` |
| Worker killed after commit and before ack | `concurrency/processes.spec.ts` |
| REFUND/ROLLBACK before the reference | `integration/wagering.spec.ts`, `integration/worker.spec.ts` |
| Restart with eventual consistency | `concurrency/processes.spec.ts` |
| Authentication (not scored) | `integration/auth.spec.ts` |

The concurrency tests use real parallelism (distinct processes and connections), not sequential mocks. The final invariant `wallet.balance == balance rebuilt from the ledger` is verified **at the end of every integration and concurrency test**, for all wallets in the database (`afterEach` with `assertGlobalLedgerInvariant`), and reinforced on every commit by the deferred constraint triggers ([§6](#6-database-schema-guarantees)).

**Isolation:** the suites truncate the database and purge the queues for each case. A preload (`test/setup.ts`) aborts the integration and concurrency suites if the full stack is running, because its workers would consume the queues observed by the tests. Unit tests do not go through this check.

## 17. Load test

`bun run test:load` — full reports in `load-test-results/`.

### Environment

Intel Core i5-1145G7 laptop (4 cores / 8 threads), 15 GB of RAM, Windows 11 + Docker Desktop, Bun 1.4.3. Full stack in Docker: **1 API instance**, 3 workers, Postgres 17, MiniStack and, in the last round, Keycloak. The load generator runs on the same machine.

### Methodology

*Closed loop*: 50 concurrent virtual users for 30s, each firing the next request as soon as the previous one finishes. 20% of the traffic on a single **hot wallet** (to stress the lock), the rest spread across 50 wallets. 10% of the requests are **replays** of previous requests (same key), and the remainder is 75% `BET` / 25% `WIN`. Outbox lag is sampled in the database every 500ms. At the end, all wallets are reconciled through the API and the global invariant is checked in the database. With authentication enabled, the script obtains the tokens from Keycloak before the load (one to create wallets, another for the transactions).

### Results

| Metric | 1. Before optimization | 2. Batch publisher | 3. With authentication |
|---|---|---|---|
| Requests | 3,772 | 4,247 | 3,548 |
| Throughput | 124.2 req/s | 139.5 req/s | 116.8 req/s |
| Latency p50 / p95 / p99 | 362 / 622 / 793 ms | 320 / 573 / 784 ms | 381 / 679 / 893 ms |
| Error rate | 0% | 0% | 0% |
| Average lock wait | 40.7 ms | 36.6 ms | 38.5 ms |
| Lock conflicts | 0 | 0 | 0 |
| Outbox: max pending | 2,874 | **562** | 214 |
| Outbox: max lag | 25.9 s | **2.55 s** | 1.03 s |
| Outbox drain after the load | 26.0 s | **1.78 s** | 0.51 s |
| Inconsistent wallets / ledger divergences | 0 / 0 | 0 / 0 | 0 / 0 |

### Analysis

**Correctness under load.** No errors, no inconsistencies and no lock conflicts in any round, with 20% of the traffic concentrated on a single wallet. This is the result that matters most.

**Latency is dominated by queueing, not by processing.** By Little's Law, 50 users ÷ 139.5 req/s ≈ 0.36 s — practically the measured p50. The system is throughput-saturated, and latency is waiting time. Contributing to the ~140 req/s ceiling: a single API instance; client and server competing for the same 8 threads; Docker Desktop virtualization on Windows; and about 6 database round-trips per transaction, because of the explicit per-operation flush ([§3](#3-orm-and-transaction-strategy)).

**Lock wait is small relative to total latency** (~37 ms average on a p50 of 320 ms). The tail (p95 ≤ 250 ms) comes from the hot wallet — it is per-wallet serialization showing up in the metric, the expected behavior. Cold wallets do not wait for each other.

**Measurement-driven optimization (round 1 → 2).** The first round showed the outbox publisher as the bottleneck: ~1.8 events per transaction produced ~220 events/s, but the 3 publishers together only published ~110/s, because they made one SQS call per event. With `SendMessageBatch` (10 per call), the max lag dropped from 25.9 s to 2.55 s and the drain from 26 s to 1.78 s. HTTP throughput barely changed, which is expected: the publisher runs in the worker, outside the request path. This confirms that the measurement isolated the right component.

**Cost of authentication (round 2 → 3).** Throughput dropped ~16% (139.5 → 116.8 req/s) and p50 rose ~60 ms. The likely reasons: RS256 signature verification on every request, on a single API instance (the keys are cached, so the cost is purely cryptographic, with no call to Keycloak); Keycloak, a JVM, competing for the same 8 threads with the API, the database and the load generator; and natural variation between rounds, which without code changes had already ranged from 124 to 139 req/s. The outbox had more headroom because lower throughput produces fewer events per second. Correctness did not change.

**Limitations of the experiment.** Single machine, with generator and system competing for CPU; Docker Desktop on Windows; MiniStack instead of real SQS; 30s rounds, too short to reveal long-term effects (table growth, autovacuum); one round per configuration, with no repetitions to estimate variance. The numbers are relative to this environment and serve to compare versions, not as production capacity.

**Performance next steps:** scale the API horizontally (the design already supports it); reduce round-trips by grouping the transaction's inserts into a single flush; measure with the load generator and Keycloak on another machine; repeat each round a few times.

## 18. Limitations and next steps

- **Fine-grained authorization:** the wallet routes accept any authenticated client, and `GET /wagering/transactions/:transactionId` does not check whether the transaction belongs to the token's provider. In production, wallet operations would require a backoffice role or scope (e.g. `wallet:write`), and the lookup by internal id would be restricted to the provider that owns the transaction.
- **Keycloak secrets in the repository:** the client secrets are hardcoded in the imported realm, since this is a local demo environment. In production they would come from a secrets manager, and the realm would not be imported in `start-dev` mode.
- **Readiness does not check Keycloak:** if the IdP goes down, the API keeps validating tokens with the cached keys; only a key rotation during the outage would cause an error (503). An optional JWKS check in `/health/ready` would make this visible.
- **Round-trips per transaction:** the explicit per-operation flush guarantees the INSERT order without ORM relations, but costs latency. A single flush with guaranteed order (via declared ORM relations, or `DEFERRABLE` constraints) would reduce the round-trips.
- **The outbox holds the transaction during publishing.** The `SKIP LOCKED` claim keeps the lock while the batch is sent to SQS. At high volume, a *lease* model (set `claimed_until`, commit, publish, confirm) would free the database sooner.
- **Event order under failure:** if a publication fails and is rescheduled while later events for the same wallet are published, the order is inverted. Consumers should use `walletVersion` (present in `WalletBalanceChanged`) to order and deduplicate.
- **Circuit breaker in the consumer:** today, with PostgreSQL down, the consumer keeps receiving messages and each failure consumes an attempt. The 10-attempt limit covers ~5 minutes of unavailability ([§13](#retry-limit-and-postgresql-unavailability)). The next step would be a circuit breaker: on the first connection `TransientInfrastructureError`, the consumer stops calling `ReceiveMessage`, returns the visibility of the messages in hand and starts probing the database (`select 1`) with backoff. When the database comes back, it resumes consuming. Since nothing is received during the outage, attempts are not spent and the DLQ goes back to receiving only messages with a real problem, regardless of how long the outage lasts. It was not implemented because it requires a test that actually takes Postgres down in the middle of processing.
- **Non-atomic DLQ:** sending to the DLQ and deleting from the main queue are two calls. A crash between them can duplicate the message in the DLQ (FIFO deduplication, by `MessageId`, covers the 5-minute window).
- **Reserved `FAILED` status:** no flow reaches it today (see [§9](#9-business-rules-and-interpretations)). A natural path would be a process that rehydrates messages from the DLQ and writes the transaction as `FAILED` as soon as the database is available, unifying the audit in a single place.
- **Immediate reprocessing of pending items:** today a `PENDING_REFERENCE` transaction waits for the worker's next cycle (~1s) even if the reference arrives right after. Triggering reprocessing right after the reference's commit would reduce this latency; the `wager_tx_waiting_reference_idx` index already exists for that lookup.
- **Reconciliation locks the wallet** briefly to read balance and ledger at the same logical instant. On a hot wallet, it competes with processing.
- **MiniStack vs real SQS:** behaviors such as `PurgeQueue` (with a 60s cooldown on AWS) and the `RedrivePolicy` may differ. The application-driven DLQ reduces this dependency.
- **Single Docker image** with development dependencies (the migrations CLI is a devDependency). A multi-stage production image would be the next step.
- **Per-process metrics:** each instance exposes its own; aggregation is left to Prometheus. There is no dashboard or OpenTelemetry (optional in the spec).
- **Out of scope, per the spec:** partial reversal and double-entry ledger.