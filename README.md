# Jungle Wallet

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos, via HTTP e via AWS SQS, mantendo saldo materializado e ledger imutável consistentes mesmo com mensagens duplicadas, fora de ordem, concorrentes e falhas de processo.

> As decisões técnicas, trade-offs e limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Linguagem | TypeScript (strict) |
| Framework | NestJS |
| Banco | PostgreSQL 17 |
| ORM | MikroORM (`EntitySchema`, domínio sem decorators) |
| Mensageria | AWS SQS FIFO via [MiniStack](https://ministack.org) |
| Observabilidade | pino (logs JSON), prom-client (métricas Prometheus) |
| Orquestração local | Docker Compose |

> **Por que MiniStack e não LocalStack?** Desde a versão 2026.03.0 o LocalStack exige auth token para iniciar. O MiniStack é uma alternativa open-source compatível na porta 4566, sem conta nem token — e é citado no próprio enunciado.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose

## Início rápido

### Opção A — stack completo no Docker (API + 3 workers)

```bash
bun install
bun run stack:up        # build + postgres + ministack + migrations + filas + api + 3 workers
docker compose ps       # api e workers devem aparecer como healthy
curl http://localhost:3000/health/ready
```

O container one-shot `setup` aplica as migrations e cria as filas antes de API e workers subirem. Para derrubar: `bun run stack:down`.

### Opção B — desenvolvimento local (processos na máquina, infra no Docker)

```bash
bun install
cp .env.example .env    # Windows: copy .env.example .env
bun run infra:up        # postgres (porta 5433) + ministack (porta 4566) + criação das filas
bun run migration:up
bun run start:api       # http://localhost:3000
bun run start:worker    # outro terminal — http://localhost:3001 (/health, /metrics)
```

## Scripts

| Script | O que faz |
|---|---|
| `infra:up` / `infra:down` | Sobe/derruba só Postgres e MiniStack (e cria as filas) |
| `stack:up` / `stack:down` | Sobe/derruba o stack completo, com 3 workers |
| `migration:up` / `migration:down` | Aplica/reverte migrations (versionadas e reversíveis) |
| `sqs:setup` | Cria as filas (idempotente) |
| `start:api` / `dev:api` | Sobe a API (o `dev` com watch) |
| `start:worker` | Sobe o worker (consumer SQS, publisher da outbox, worker de referências) |
| `typecheck` | `tsc --noEmit` em modo strict |
| `test:unit` | Testes de unidade |
| `test:integration` | Testes de integração contra Postgres e SQS reais |
| `test:concurrency` | Testes com múltiplos processos reais do worker |
| `test:load` | Teste de carga contra o stack completo |

## Testes

Nenhum teste substitui PostgreSQL ou SQS por mocks: integração e concorrência rodam contra os containers reais.

```bash
bun run typecheck
bun run test:unit
bun run infra:up && bun run migration:up
bun run test:integration
bun run test:concurrency
```

> **Importante:** as suítes de integração e concorrência rodam **só com a infra** (`infra:up`). Se o stack completo estiver ligado, os workers dele consomem as mesmas filas e publicam a mesma outbox que os testes observam. A suíte detecta isso e aborta com uma mensagem; para resolver: `docker compose stop api worker`.

### Suíte de concorrência no Linux (inclui o teste de SIGTERM)

O teste de SIGTERM é pulado no Windows, que não tem esse sinal (o processo é terminado direto). Para rodar a suíte completa num container Linux, com o stack de pé e os workers parados:

```bash
bun run stack:up
docker compose stop worker
docker compose run --rm -e NODE_ENV=test api bun run test:concurrency
```

### O que a suíte de concorrência prova

| Cenário | Resultado verificado |
|---|---|
| 3 processos numa hot wallet (150 apostas de 10.00 em 1000.00, cada mensagem entregue 2×) | exatamente 100 processadas, 50 rejeitadas, saldo 0.00, 101 lançamentos |
| Wallets distintas em paralelo em 3 processos | todas com saldo e ledger corretos |
| Worker morto **após o commit e antes do ack** (fault injection) | redelivery cai no inbox, débito não duplica |
| SIGKILL em todas as instâncias no meio do processamento | após reinício, estado final consistente |
| 3 publishers da outbox em processos diferentes | cada evento publicado exatamente uma vez |
| SIGTERM durante processamento | drena o que está em andamento; nada se perde após reinício |

Invariante verificada ao final dos testes: `wallet.balance == saldo reconstruído pelo ledger`, para todas as wallets.

## Teste de carga

```bash
bun run stack:up
bun run test:load
```

Variáveis opcionais: `LOAD_CONCURRENCY` (50), `LOAD_DURATION_S` (30), `LOAD_WALLETS` (50), `LOAD_HOT_RATIO` (0.2). O relatório completo (ambiente, metodologia, resultados) é salvo em `load-test-results/`.

Resultado de referência (50 usuários concorrentes, 30s, 20% do tráfego numa hot wallet, notebook i5-1145G7 4C/8T, Windows + Docker Desktop):

| Métrica | Valor |
|---|---|
| Throughput | 139.5 req/s |
| Latência p50 / p95 / p99 | 320 / 573 / 784 ms |
| Taxa de erro | 0% |
| Espera média pelo lock da wallet | 36.6 ms |
| Outbox: lag máximo / drenagem após a carga | 2.55 s / 1.78 s |
| Wallets inconsistentes após a carga | 0 de 51 |

A análise completa — incluindo a otimização do publisher guiada por essa medição, que reduziu o lag da outbox em ~10× — está em [ARCHITECTURE.md](./ARCHITECTURE.md#17-teste-de-carga).

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet (saldo inicial gera transação `OPENING` + lançamento) |
| `GET` | `/wallets/:walletId` | Consulta wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Ledger paginado com cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo materializado com o ledger |
| `POST` | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| `GET` | `/health/live` / `/health/ready` | Liveness / readiness (Postgres e SQS) — sem autenticação |
| `GET` | `/metrics` | Métricas Prometheus |

### Exemplo

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<id retornado acima>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Status HTTP: `200` processada (nova ou replay) · `202` aguardando referência · `422` rejeitada por regra de negócio · `400` payload inválido · `404` inexistente · `409` conflito de idempotência · `503` falha transitória. Detalhes em [ARCHITECTURE.md](./ARCHITECTURE.md#12-mapeamento-de-status-http).

### Mensagem SQS (`wager-transactions.fifo`)

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

## Observabilidade

- **Logs:** JSON numa linha (pino), com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` anexados automaticamente. Corpo de requisição nunca é logado; credenciais e campos financeiros são mascarados.
- **Métricas:** `GET /metrics` na API (3000) e no worker (3001). Ver lista em [ARCHITECTURE.md](./ARCHITECTURE.md#15-observabilidade).
- **Health:** `/health/live` (processo vivo) e `/health/ready` (Postgres e SQS alcançáveis).

## Estrutura

```
src/
├── main.api.ts / api.module.ts         # composition root do processo da API
├── main.worker.ts / worker.module.ts   # composition root do processo do worker
├── worker.lifecycle.ts                 # start dos loops e drenagem no SIGTERM
├── config/                             # env validado, CoreModule (ORM, repositórios, runner)
├── shared/                             # Money, erros, eventos, ports, infra transversal
└── modules/
    ├── wallet/                         # Wallet, ledger, abertura, consultas, reconciliação
    ├── wagering/                       # WagerTransaction, regras, use cases, HTTP, consumer, worker
    ├── messaging/                      # Inbox, Outbox, publisher
    ├── health/
    └── auth/                           # ponto de extensão (não implementado — ver ARCHITECTURE.md)
migrations/                             # schema, constraints, índices e triggers
test/{unit,integration,concurrency,load}
```

Cada módulo segue `domain/` (sem dependência de framework) → `application/` (use cases e ports) → `infrastructure/` (adapters: persistência, HTTP, SQS).