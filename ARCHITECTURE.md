# Arquitetura

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas. A ordem segue as áreas de avaliação do desafio.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Autenticação](#2-autenticação)
3. [ORM e estratégia transacional](#3-orm-e-estratégia-transacional)
4. [Money](#4-money)
5. [Modelo de domínio](#5-modelo-de-domínio)
6. [Garantias no schema do banco](#6-garantias-no-schema-do-banco)
7. [Concorrência](#7-concorrência)
8. [Idempotência](#8-idempotência)
9. [Regras de negócio e interpretações](#9-regras-de-negócio-e-interpretações)
10. [Referências fora de ordem](#10-referências-fora-de-ordem)
11. [Taxonomia de failureCode](#11-taxonomia-de-failurecode)
12. [Mapeamento de status HTTP](#12-mapeamento-de-status-http)
13. [Mensageria: consumer, inbox e outbox](#13-mensageria-consumer-inbox-e-outbox)
14. [Eventos de integração](#14-eventos-de-integração)
15. [Observabilidade](#15-observabilidade)
16. [Testes](#16-testes)
17. [Teste de carga](#17-teste-de-carga)
18. [Limitações e próximos passos](#18-limitações-e-próximos-passos)

---

## 1. Visão geral

```
                   ┌───────────┐
                   │ Keycloak  │  (JWKS: chaves de assinatura)
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

São **dois processos** com composition roots separados (`api.module.ts` e `worker.module.ts`), escaláveis de forma independente (`docker compose up --scale worker=3`). Ambos chamam **o mesmo** `ProcessWagerTransaction`: a regra de negócio é uma só, e só o adaptador de entrada muda.

Cada módulo segue três camadas:

- **`domain/`** — entidades, value objects, regras e ports. Sem NestJS, sem ORM.
- **`application/`** — casos de uso, orquestração transacional, ports de infraestrutura.
- **`infrastructure/`** — adapters: persistência (MikroORM), HTTP (controllers + zod), SQS.

## 2. Autenticação

**Implementada com Keycloak (OIDC), integrado como Identity Provider externo.** Não há tabela de usuários nem autenticação artesanal.

**Identidade dos provedores.** O realm `jungle` (importado no boot a partir de `docker/keycloak/realm-jungle.json`) tem um client por provedor (`provider-a`, `provider-b`) e um client `backoffice`, todos no fluxo *client credentials* — o fluxo de máquina-a-máquina, adequado a integrações entre sistemas. Dois mappers por client: um hardcoded que adiciona o claim **`provider_id`** ao access token (só nos clients de provedor) e um de audiência que inclui **`wallet-api`** no `aud`.

**Validação local do JWT.** A API não consulta o Keycloak a cada requisição. O adapter `JwtProviderIdentity` valida o token com a lib `jose`: assinatura RS256 contra o JWKS do realm (buscado uma vez e mantido em cache, com renovação automática na rotação de chaves), `iss`, `aud` e `exp`. Falha ao buscar as chaves é tratada como **falha de infraestrutura (503)**, não como credencial inválida (401).

**Onde cada regra mora:**

- `ProviderIdentityPort` — o port. Dois adapters: `JwtProviderIdentity` (`AUTH_MODE=keycloak`) e `DisabledProviderIdentity` (`AUTH_MODE=disabled`, para desenvolvimento local e testes que não tratam de auth). O modo é lido no bootstrap.
- `AuthGuard` — **guard global** (`APP_GUARD`). Exige identidade válida em toda rota não marcada com `@Public()` (marcadas: `/health` e `/metrics`) e guarda a identidade na request.
- `assertProviderAccess` — **validação de domínio na borda HTTP.** Em `POST /wagering/transactions`, o `providerId` do corpo precisa ser igual ao `provider_id` do token; em `GET /providers/:providerId/...`, o do path. Caso contrário, **403**. Um provedor não age em nome de outro, e o backoffice não submete apostas.

**Por que dois endereços do Keycloak.** O token é emitido para quem o pede em `localhost:8080` (o `iss` é `http://localhost:8080/realms/jungle`), mas a API roda dentro da rede do Docker, onde `localhost` é o próprio container. Por isso a configuração separa o `OIDC_ISSUER` (validado no token) do `OIDC_JWKS_URL` (de onde as chaves são buscadas, `http://keycloak:8080/...`).

**Fila SQS.** Tratada como canal interno confiável, como define o enunciado: o worker não exige token. A identidade do provedor contida na mensagem passa pelas mesmas validações de domínio, porque o use case é o mesmo.

**Teste sem Keycloak.** `test/integration/auth.spec.ts` sobe a API em modo `keycloak`, mas gera um par de chaves RSA no próprio teste e serve um JWKS local. Cobre token válido, ausente, expirado, assinado por outra chave, com audiência ou emissor errados, provedor agindo como outro, backoffice submetendo aposta e rotas públicas.

## 3. ORM e estratégia transacional

**MikroORM**, a opção preferencial do enunciado.

**Mapeamento:** `EntitySchema` sobre classes `*Record` simples, e mappers que convertem record ⇄ domínio via `rehydrate`. O domínio não conhece o ORM: construtores privados, sem decorators — exigências do enunciado que conflitariam com entidades anotadas diretamente.

**Transação:** um port `TransactionRunner` cuja implementação faz `em.fork().transactional(...)`. O MikroORM registra o fork no `TransactionContext` (AsyncLocalStorage), então os repositórios usam o `EntityManager` injetado e participam automaticamente da transação corrente, sem receber a transação por parâmetro. O runner também traduz exceções do driver para erros da aplicação (`UniqueConstraintConflictError`, `TransientInfrastructureError`), e a camada de aplicação não conhece o ORM.

**Sem relações ORM entre agregados.** Agregados se referenciam por id (DDD). Como o ORM então não consegue deduzir a ordem dos INSERTs pelas FKs, os repositórios fazem `flush` explícito em cada `add`/`save`, dentro da mesma transação. A ordem fica determinística (transação → ledger → wallet → outbox) e a atomicidade é preservada.

**Trade-off assumido:** a separação record/mapper dobra o código de persistência e abre mão de parte do Unit of Work e do Identity Map no domínio — que são justamente os atrativos do MikroORM. Em troca, o domínio fica testável sem banco e protegido de detalhes de persistência. O flush por operação também custa round-trips (ver [§17](#17-teste-de-carga)).

## 4. Money

- Valor interno em **`decimal.js`** (instância clonada, isolada de configuração global). `number` nunca é usado para dinheiro em nenhuma camada.
- **Contrato estrito:** `amount` é string com **exatamente 2 casas** (`"25.00"`), sem sinal, sem notação científica, até 17 dígitos inteiros (o limite de `numeric(19,2)`). `"25"` e `"25.5"` são rejeitados: o enunciado define escala fixa, e a regex é a única coisa a mudar se for preciso afrouxar.
- **Nada é arredondado.** Uma entrada com 3 casas é rejeitada, nunca arredondada em silêncio: alterar o valor enviado por um provedor é pior do que recusá-lo.
- Imutável: toda operação devolve uma nova instância. Operações entre moedas diferentes lançam `CurrencyMismatchError`; `equals` entre moedas diferentes devolve `false`.
- `from()` rejeita negativos (contrato de entrada), mas `subtract()` pode produzir negativo internamente — necessário, por exemplo, para a diferença na reconciliação. Quem impede saldo negativo é a `Wallet` e o `CHECK` do banco.
- **Persistência:** `numeric(19,2)` + coluna `currency char(3)`. O driver `pg` devolve `numeric` como string (`"975.00"`), então o valor vai do banco ao `Money.from` sem passar por `number`.
- O desafio assume uma única moeda (BRL), mas o modelo é multi-moeda e os conflitos de moeda são testados.

## 5. Modelo de domínio

Todas as classes seguem **construtor privado + factories** (`create`/`open`/`from`), e `rehydrate` reconstrói o estado persistido **sem revalidar transições**.

- **`Wallet`** (aggregate root): `debit`/`credit` **devolvem o `WalletLedgerEntry`**. Não existe forma de mudar o saldo sem receber o lançamento correspondente. O lançamento é criado **antes** de mutar a wallet: se a validação falhar, a wallet fica intacta. `version` começa em 1 e só incrementa quando o saldo muda. `canDebit()` separado de `debit()` permite ao wagering escolher o `failureCode` correto conforme o contexto.
- **`WalletLedgerEntry`:** campos `readonly` e `Object.freeze` no construtor — imutabilidade estrutural em runtime, não só em compile time. `create` valida a aritmética (`balanceBefore ± money === balanceAfter`).
- **`WagerTransaction`:** estado encapsulado, transições explícitas.
- **`evaluateReference`:** função pura que aplica as regras de referência da seção 7 do enunciado e devolve `accept`, `wait` ou `reject` com código. Quem busca a referência no banco é o use case; a regra é testada em unitário, com um caso por `failureCode` (`test/unit/reference-policy.spec.ts`).

**Dois tipos de erro:**

- `DomainError` — caminho de negócio ou de contrato, sempre com `failureCode`.
- `InvariantViolationError` — erro de programação (estado impossível, transição a partir de estado terminal). Sem `failureCode`, vira 500.

### Transições de `WagerTransaction`

| De | Para |
|---|---|
| `PENDING` | `PROCESSED`, `PENDING_REFERENCE`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` (e reagendamento de tentativa, sem mudar de status) |
| `PROCESSED` / `REJECTED` / `FAILED` | nenhuma — `InvalidTransactionStateError` |

As mesmas regras são reforçadas no banco pelo trigger `wager_tx_guard_update`.

Adaptações de assinatura em relação aos esqueletos do enunciado: `markProcessed` e `reject` recebem também o saldo observado (o replay precisa devolvê-lo, inclusive para `LOSS` e `REJECTED`, que não têm lançamento), e `WalletLedgerEntry` carrega `walletVersion`, que dá a sequência imutável por wallet.

## 6. Garantias no schema do banco

O enunciado exige que unicidade, imutabilidade e não-negatividade sejam aplicadas **no schema**, não só no código. O schema é deliberadamente estrito: a aplicação é a primeira barreira, e o banco é a última.

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` e nos saldos do ledger |
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Transação pertence à wallet, player e moeda declarados | FK composta `(wallet_id, player_id, currency) → wallets` |
| Lançamento na mesma moeda/wallet da transação | FK composta `(transaction_id, wallet_id, currency) → wager_transactions` |
| No máximo um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| Sem lost update | `UNIQUE (wallet_id, wallet_version)` no ledger |
| Aritmética do lançamento | `CHECK` de `balance_before ± amount = balance_after` |
| Ledger imutável | trigger que bloqueia `UPDATE`/`DELETE` |
| Ledger encadeado | trigger: `balance_before` da entrada N = `balance_after` da N-1 |
| Saldo ⇔ ledger (nos dois sentidos) | constraint triggers `DEFERRABLE INITIALLY DEFERRED`, checados no commit |
| Estados terminais imutáveis | trigger `wager_tx_guard_update` (também bloqueia mudança de colunas de negócio) |
| `OPENING` só interno | `CHECK ((kind = 'OPENING') = (provider_id = '__system__'))` |
| Reversão única | índice único parcial em `reference_transaction_id` para reversões `PROCESSED` |
| Referência obrigatória/proibida por kind | `CHECK`s por `kind` |
| `failureCode` coerente com status | `CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL))` |

**Por que constraint triggers diferidos?** Dentro de uma transação, a wallet e o lançamento são gravados em sequência; um check imediato falharia no estado intermediário. Diferido, ele avalia o estado final no commit: se o saldo da wallet não bater com o `balance_after` do lançamento da versão atual, **o commit inteiro é recusado**.

**Regra da primeira entrada:** uma wallet aberta com saldo zero nasce em `version = 1` sem lançamento, e seu primeiro movimento gera `walletVersion = 2`. O trigger de encadeamento aceita como primeira entrada a versão 1 (abertura com saldo) ou 2 (primeiro movimento de wallet aberta com zero), sempre com `balance_before = 0`. Esse caso foi encontrado por um teste de integração — exemplo de um descompasso entre domínio e schema que quebra alto em vez de passar em silêncio.

Migrations são versionadas, escritas em SQL explícito e reversíveis (`up`/`down`), verificadas com `down` completo seguido de `up`.

## 7. Concorrência

**A unidade de concorrência é a `walletId`.**

**Estratégia: lock pessimista por wallet** (`SELECT ... FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`), dentro da transação, antes de qualquer leitura de regra. Tudo que toca uma wallet fica serializado; wallets diferentes rodam em paralelo. Não há lock global.

**Por que pessimista e não otimista?**

- Hot wallets (um jogador muito ativo) são o caso normal em iGaming. Com lock otimista, cada conflito vira retry: sob contenção alta, os retries se multiplicam e a latência de cauda explode, com risco de esgotar o limite de tentativas.
- Com lock pessimista, a contenção vira **fila** no banco: comportamento determinístico, sem retry na aplicação e sem caminho de "tentativas esgotadas" para uma operação válida.
- O custo é a serialização por wallet, que é exatamente a semântica correta para saldo.

`version` continua incrementando (exigido pelo enunciado), e `UNIQUE (wallet_id, wallet_version)` funciona como detector de lost update no banco, independente da estratégia de lock.

**Ordem de lock fixa — wallet primeiro.** O worker de referências pendentes descobre a wallet numa leitura sem lock e, numa segunda transação, trava a wallet antes de reler a transação. Com a ordem sempre igual, não há ciclo de espera (deadlock).

**Cenário obrigatório (seção 8):** saldo 100.00, duas apostas de 80.00 simultâneas. A segunda transação espera o lock; quando o obtém, lê o saldo já debitado (20.00) e rejeita com `INSUFFICIENT_FUNDS`. Resultado: uma `PROCESSED`, uma `REJECTED`, saldo 20.00, um lançamento de débito. Coberto em `test/integration/wagering.spec.ts`, e em escala com 3 processos em `test/concurrency/processes.spec.ts`.

**Múltiplas instâncias:** a correção não depende de nada em memória. O lock, a idempotência, o inbox e o claim da outbox estão no Postgres, então N instâncias se comportam como uma. Testado com 3 processos reais.

## 8. Idempotência

- O header **`Idempotency-Key` é obrigatório e é a fonte da verdade**. O escopo é `(providerId, idempotencyKey)`, protegido por `UNIQUE` no banco.
- **`payloadHash`** = SHA-256 (hex) do **JSON canônico** — chaves ordenadas recursivamente, `undefined` omitido — do subconjunto de campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`. Header, `correlationId` e metadados de transporte ficam fora.
- **Mesma key + mesmo hash →** replay: devolve o resultado original (mesmo `transactionId`, status e **saldo observado naquele momento**, guardado em `observed_balance`) com `idempotentReplay: true`. O status HTTP é o mesmo do original.
- **Mesma key + hash diferente →** `409 IDEMPOTENCY_CONFLICT`. Também é conflito o mesmo `externalTransactionId` com outra key.
- **A checagem acontece depois do lock da wallet.** Com isso, 50 requisições idênticas simultâneas se serializam: a primeira processa, as outras 49 encontram a transação já gravada e viram replay. Coberto pelo teste "a mesma aposta enviada 50 vezes em paralelo → um único débito".
- **Backstop:** se duas requisições com a mesma key mas `walletId` diferente correrem juntas (locks diferentes), uma bate no `UNIQUE`. O use case repete uma vez, e a segunda tentativa vira replay ou conflito.
- **SQS:** além da key, um **inbox persistente** por `(consumerName, messageId)`, gravado na mesma transação dos efeitos. Um `messageId` repetido só vira replay se o conteúdo for idêntico: o inbox guarda o `payload_hash`, e um `messageId` reutilizado com outro conteúdo é **conflito** (vai para a DLQ com `IDEMPOTENCY_CONFLICT`), nunca um replay silencioso. Nenhuma garantia depende de cache em memória nem da deduplicação do SQS FIFO.

## 9. Regras de negócio e interpretações

| Tema | Interpretação adotada | Motivo |
|---|---|---|
| Reversão única | Uma transação pode ser revertida **uma única vez, por qualquer tipo** (`REFUND` ou `ROLLBACK`) | O enunciado fala em "mesmo tipo", mas permitir `REFUND` e `ROLLBACK` sobre a mesma `BET` creditaria duas vezes. Um `ROLLBACK` de um `REFUND` continua possível, pois referencia outra transação |
| Valor | `> 0` para todo kind, exceto `LOSS` (aceita `0`) | `LOSS` só registra o resultado |
| `WIN` | Referência opcional; se informada, deve apontar para uma `BET` do mesmo escopo | "Pode referenciar" no enunciado |
| Escopo da referência | Mesmo provider, player, wallet, moeda e rodada | Seção 7 do enunciado |
| Referência ainda pendente | Se a referência existe mas também está `PENDING_REFERENCE`, a transação **espera** (não é rejeitada) | Ex.: `ROLLBACK` de um `REFUND` que ainda aguarda sua `BET` |
| Reversão sem saldo | `REJECTED` com `REVERSAL_WOULD_OVERDRAW`, distinto de `INSUFFICIENT_FUNDS` | Exigência do enunciado: são situações operacionalmente diferentes |
| Erros de contrato | Wallet inexistente, player de outra wallet, moeda diferente e payload inválido **não são persistidos** como `REJECTED` | A FK composta impede gravar transação com player/moeda diferentes da wallet. `REJECTED` fica para regra de negócio sobre uma transação válida |
| `OPENING` | Provider reservado `__system__`, `externalTransactionId = opening:{walletId}` | Não pode ser submetido por API nem fila (validado no use case e no banco) |
| Formato de `amount` | Exatamente 2 casas | "Escala fixa de 2 casas" no enunciado |
| Status `FAILED` | Existe no modelo, no schema e nas transições, mas nenhum fluxo atual o atinge. Falhas permanentes de infraestrutura são registradas na **DLQ** (motivo, detalhe e tentativas nos atributos), não na transação | A falha permanente típica (banco indisponível) impede justamente gravar a transação. Persistir `FAILED` exigiria uma segunda escrita depois que o banco voltasse, sem ganho de auditoria sobre a DLQ |

## 10. Referências fora de ordem

- Referência ausente → `PENDING_REFERENCE`, evento `WagerTransactionPendingReference` e agendamento da próxima tentativa.
- Um worker agendado (`PendingReferenceWorker`) busca as transações vencidas e reprocessa cada uma na própria transação, com o mesmo `WagerTransactionProcessor` da entrada nova. Dois workers no mesmo item são seguros: o segundo trava a wallet, relê o estado e pula se já foi resolvido ou reagendado.
- **Política:** até 10 reagendamentos com backoff exponencial — intervalos de 1s, 2s, 4s… dobrando até o teto de 5min, num total de 11 reprocessamentos pelo worker e **≈18,5 minutos** (1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 300 + 300 = 1.111s). Configurável por env (`REFERENCE_RETRY_*`).
- **Justificativa:** entrega fora de ordem vem de corrida entre mensagens, que se resolve em segundos. Uma referência que não chegou em ~18 minutos dificilmente vai chegar, e esperar mais só atrasa o feedback ao provedor.
- Esgotado o limite → `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## 11. Taxonomia de failureCode

Códigos estáveis e legíveis por máquina, suficientes para o provedor decidir se reenvia, corrige ou desiste.

| failureCode | Onde aparece | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `REJECTED` (422) | Desistir; a aposta não é aceita |
| `REVERSAL_WOULD_OVERDRAW` | `REJECTED` (422) | Escalar operacionalmente: reversão legítima sem saldo |
| `REFERENCE_NOT_FOUND` | `REJECTED` (422), após esgotar as tentativas | Verificar se a transação referenciada foi enviada |
| `REFERENCE_MISMATCH` | `REJECTED` (422) | Corrigir a referência (escopo diferente) |
| `REFERENCE_KIND_NOT_ALLOWED` | `REJECTED` (422) | Corrigir: ex. `REFUND` de algo que não é `BET` |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` (422) | A referência foi rejeitada; nada a reverter |
| `REFERENCE_ALREADY_REVERSED` | `REJECTED` (422) | Desistir; já revertida |
| `REVERSAL_AMOUNT_MISMATCH` | `REJECTED` (422) | Corrigir o valor (reversão parcial fora de escopo) |
| `INVALID_PAYLOAD` / `INVALID_MONEY` | erro 400 | Corrigir o payload |
| `CURRENCY_MISMATCH` / `WALLET_PLAYER_MISMATCH` | erro 400 | Corrigir o payload |
| `UNAUTHENTICATED` | erro 401 + `WWW-Authenticate: Bearer` | Obter um token válido e reenviar |
| `FORBIDDEN` | erro 403 | Não reenviar: o client não pode agir como esse provedor |
| `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | erro 404 | Verificar os ids |
| `IDEMPOTENCY_CONFLICT` | erro 409 | Não reenviar com a mesma key: o payload divergiu |
| `WALLET_ALREADY_EXISTS` | erro 409 | Usar a wallet existente |
| `TRANSIENT_INFRASTRUCTURE_ERROR` | erro 503 + `Retry-After` | **Reenviar com a mesma key** |
| `PERMANENT_INFRASTRUCTURE_ERROR` | status `FAILED` (reservado, ver [§9](#9-regras-de-negócio-e-interpretações)) | Auditável; investigar |
| `INTERNAL_ERROR` | erro 500 | Reportar |

## 12. Mapeamento de status HTTP

Mesmo código para a mesma situação, em todos os endpoints.

| Situação | HTTP | Corpo |
|---|---|---|
| Processada (nova ou replay) | **200** | `WagerResult` |
| Aceita, aguardando referência | **202** | `WagerResult` (`PENDING_REFERENCE`) |
| Rejeitada por regra de negócio | **422** | `WagerResult` com `failureCode` |
| Payload inválido / contrato | **400** | `{ error: { code, message, retryable, details? } }` |
| Sem token válido | **401** + `WWW-Authenticate: Bearer` | `{ error }` |
| Client não autorizado para o provedor | **403** | `{ error }` |
| Recurso inexistente | **404** | `{ error }` |
| Conflito de idempotência / wallet duplicada | **409** | `{ error }` |
| Falha transitória de infraestrutura (inclui chaves do IdP indisponíveis) | **503** + `Retry-After` | `{ error: { retryable: true } }` |
| Erro inesperado | **500** | `{ error: { code: INTERNAL_ERROR } }` |

A rejeição de negócio devolve o `WagerResult` completo (`transactionId`, saldo), porque a transação existe e é auditável. Os erros de contrato devolvem `{ error }`, porque nada foi persistido. O provedor distingue pelo status **e** pelo formato do corpo, sem interpretar mensagem. O replay devolve o mesmo status do original (um 422 continua 422). A autenticação roda antes da validação do corpo, então uma requisição sem token recebe 401 mesmo com payload inválido.

## 13. Mensageria: consumer, inbox e outbox

### Consumer SQS

Long polling na `wager-transactions.fifo`, chamando o mesmo use case da API.

| Resultado | Ação |
|---|---|
| Processou (inclusive `REJECTED` e `PENDING_REFERENCE`) | **ack** — sempre pós-commit (`execute` só retorna depois do commit) |
| Erro de contrato (payload inválido, wallet inexistente, conflito de idempotência) | **DLQ imediata**: reenviar não resolve |
| Mensagem malformada (JSON/envelope) | **DLQ imediata** |
| Falha transitória ou erro inesperado | **retry** com backoff via `ChangeMessageVisibility` (2s, 4s, 8s… teto 60s) |
| Atingiu `maxReceiveCount` (5) | **DLQ** com motivo `RETRIES_EXHAUSTED` |

- **DLQ feita pela aplicação:** envia para `wager-transactions-dlq.fifo` com `failureReason`, `failureDetail` e `receiveCount` nos atributos, e só então apaga da fila principal. Fica auditável e não depende da `RedrivePolicy` (configurada mesmo assim, como rede de segurança).
- **Paralelismo entre grupos, ordem dentro do grupo:** cada lote recebido é agrupado por `MessageGroupId`; grupos diferentes em paralelo, mensagens do mesmo grupo em sequência.
- **SIGTERM:** para de buscar mensagens (aborta o long polling), conclui as que estão em andamento e devolve a visibilidade (`VisibilityTimeout = 0`) das que ainda não começaram. No Compose, `init: true` (tini como PID 1) repassa o sinal e `stop_grace_period: 30s` dá tempo para drenar.
- **Crash entre commit e ack:** a mensagem volta após o visibility timeout, o inbox detecta a duplicata e o resultado vira replay — sem efeito duplicado. Testado com um gancho de fault injection (`CHAOS_EXIT_BEFORE_ACK`, desligado por padrão) que encerra o processo exatamente nesse ponto. Se o próprio `ack` falhar (erro de rede), a mensagem é reagendada como falha transitória, com o mesmo resultado seguro.

### Inbox

Registrado com `INSERT ... ON CONFLICT DO NOTHING` **na mesma transação** da alteração financeira, já marcado como processado: se o commit aconteceu, a mensagem foi processada; se não, nada existe e o redelivery reprocessa. Duas entregas simultâneas da mesma mensagem: a segunda espera o commit da primeira e cai no conflito, onde o `payload_hash` decide entre replay e conflito ([§8](#8-idempotência)).

### Transactional Outbox

- Transação, saldo, ledger, inbox e eventos são gravados no **mesmo commit**. Nenhum evento é publicado antes do commit.
- **Claim com `FOR UPDATE SKIP LOCKED`:** publishers concorrentes pegam lotes disjuntos. Se um publisher morre no meio, a transação dele faz rollback, o lock é liberado e outro assume.
- **`outbox.id = eventId`**, usado como `MessageDeduplicationId` no SQS e como chave de dedup para consumidores: uma republicação carrega o mesmo `eventId`.
- **`MessageGroupId = aggregateId = walletId`:** eventos de uma wallet saem em ordem.
- **Envio em lote** (`SendMessageBatch`, 10 por chamada), lotes em sequência para preservar a ordem dentro do claim. Falhas parciais são tratadas entrada por entrada.
- **Sem limite de tentativas:** um evento confirmado não pode ser perdido (invariante do enunciado). Ele fica em retry com backoff (1s → teto 60s), e a métrica `wallet_outbox_lag_seconds` é o alerta.

## 14. Eventos de integração

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` e `OPENING` |
| `WagerTransactionRejected` | rejeição por regra de negócio (inclusive `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | somente quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente |

Envelope: classe abstrata `IntegrationEvent<T>` com uma subclasse concreta por evento. `eventType` e `version` ficam no tipo, não em strings soltas no call site. `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money`, garantindo JSON estável e versionável. `correlationId` propaga o da requisição/mensagem de origem, e `causationId` aponta a key ou o `messageId` que causou o evento.

## 15. Observabilidade

### Logs

- **JSON numa linha** (pino via `nestjs-pino`), com `level`, `time` (ISO), `service` (`api`/`worker`) e `msg`.
- **Contexto automático:** um `LogContext` sobre `AsyncLocalStorage` guarda `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` durante o processamento de uma requisição ou mensagem, e o pino injeta esses campos em toda linha via `mixin`. O `correlationId` vem do header `x-correlation-id` (ou é gerado) e volta na resposta.
- **Sem dados sensíveis:** o log de request registra método, URL, status e tempo — nunca o corpo. `redact` mascara `authorization` (o token), `cookie` e, defensivamente, `money`/`balance`. Logs de negócio registram status, kind e `failureCode`, não valores.

### Métricas (`GET /metrics`)

| Métrica | Tipo | O que mede |
|---|---|---|
| `wallet_transactions_total{status,source}` | counter | transações por status e entrada (`http`/`sqs`/`worker`) |
| `wallet_transaction_processing_seconds{source}` | histogram | latência de processamento |
| `wallet_duplicates_detected_total{source}` | counter | replays idempotentes e duplicatas do inbox |
| `wallet_retries_total{component}` | counter | retries do consumer, da outbox e das referências |
| `wallet_dlq_messages_total{reason}` | counter | mensagens enviadas à DLQ, por motivo |
| `wallet_lock_wait_seconds` | histogram | espera pelo lock da wallet |
| `wallet_lock_conflicts_total{reason}` | counter | deadlock, lock timeout, corrida de unicidade |
| `wallet_outbox_pending` / `wallet_outbox_lag_seconds` | gauge | backlog e idade do evento mais antigo não publicado |
| `wallet_outbox_published_total` | counter | eventos publicados |
| `wallet_reconciliation_divergences_total` | counter | wallets com saldo divergente do ledger |

**Sobre "conflitos de lock":** com lock pessimista, contenção não aparece como erro, aparece como espera. Por isso a métrica principal é `wallet_lock_wait_seconds` — uma hot wallet aparece como cauda longa no histograma. O contador de conflitos fica para os casos excepcionais.

### Health checks

`/health/live` (processo vivo, sem dependências) e `/health/ready` (Postgres e SQS alcançáveis, com timeout de 2s; 503 se algum falhar). Ambos públicos, na API e no worker.

### Reconciliação

`POST /wallets/:walletId/reconciliation` trava a wallet brevemente, compara o saldo materializado com a soma do ledger e responde com a diferença. Divergência **nunca é corrigida silenciosamente**: é logada, contabilizada em métrica e sinalizada com `consistent: false`.

## 16. Testes

| Nível | Onde | Infra |
|---|---|---|
| Unidade | `test/unit` | nenhuma |
| Integração | `test/integration` | Postgres e MiniStack reais (auth com JWKS local) |
| Concorrência | `test/concurrency` | Postgres, MiniStack e **processos reais** do worker (`Bun.spawn`) |
| Carga | `test/load` | stack completo no Docker, com Keycloak |

### Cobertura dos testes obrigatórios

| Exigência do enunciado | Teste |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `unit/money.spec.ts` |
| Invariantes da Wallet | `unit/wallet.spec.ts`, `unit/wallet-ledger-entry.spec.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK | `unit/wager-transaction.spec.ts`, `unit/reference-policy.spec.ts`, `integration/wagering.spec.ts` |
| Conflito de moeda | `unit/money.spec.ts`, `unit/wallet.spec.ts`, `integration/wagering.spec.ts` |
| Idempotency key com payload divergente | `integration/wagering.spec.ts` (inclusive `messageId` reutilizado), `integration/http.spec.ts` |
| Migrations e constraints | `integration/persistence-and-constraints.spec.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `integration/wagering.spec.ts` (eventos gravados no mesmo commit), constraints diferidos |
| Inbox e redelivery | `integration/messaging-persistence.spec.ts`, `integration/worker.spec.ts` |
| Publishers concorrentes na mesma outbox | `integration/messaging-persistence.spec.ts`, `concurrency/processes.spec.ts` |
| Retry e DLQ | `integration/worker.spec.ts` |
| Recuperação após reinicialização | `concurrency/processes.spec.ts` (SIGKILL em todas as instâncias) |
| Mesma aposta 50× em paralelo → um débito | `integration/wagering.spec.ts` |
| Disputa de saldo na mesma wallet (seção 8) | `integration/wagering.spec.ts`, `concurrency/processes.spec.ts` |
| Wallets distintas em paralelo | `integration/wagering.spec.ts`, `concurrency/processes.spec.ts` |
| ≥ 3 processos simultâneos | `concurrency/processes.spec.ts` |
| Worker morto após commit e antes do ack | `concurrency/processes.spec.ts` |
| REFUND/ROLLBACK antes da referência | `integration/wagering.spec.ts`, `integration/worker.spec.ts` |
| Reinício com consistência final | `concurrency/processes.spec.ts` |
| Autenticação (fora da pontuação) | `integration/auth.spec.ts` |

Os testes de concorrência usam paralelismo real (processos e conexões distintas), não mocks sequenciais. A invariante final `wallet.balance == saldo reconstruído pelo ledger` é verificada **ao fim de todos os testes de integração e concorrência**, para todas as wallets do banco (`afterEach` com `assertGlobalLedgerInvariant`), e reforçada em todo commit pelos constraint triggers diferidos ([§6](#6-garantias-no-schema-do-banco)).

**Isolamento:** as suítes truncam o banco e purgam as filas a cada caso. Um preload (`test/setup.ts`) aborta a execução das suítes de integração e concorrência se o stack completo estiver ligado, porque seus workers consumiriam as filas observadas pelos testes. Os testes unitários não passam por essa checagem.

## 17. Teste de carga

`bun run test:load` — relatórios completos em `load-test-results/`.

### Ambiente

Notebook Intel Core i5-1145G7 (4 núcleos / 8 threads), 15 GB de RAM, Windows 11 + Docker Desktop, Bun 1.4.3. Stack completo no Docker: **1 instância da API**, 3 workers, Postgres 17, MiniStack e, na última rodada, Keycloak. O gerador de carga roda na mesma máquina.

### Metodologia

*Closed loop*: 50 usuários virtuais concorrentes por 30s, cada um disparando a próxima requisição assim que a anterior termina. 20% do tráfego numa única **hot wallet** (para estressar o lock), o resto espalhado em 50 wallets. 10% das requisições são **replays** de requisições anteriores (mesma key), e o restante é 75% `BET` / 25% `WIN`. O outbox lag é amostrado no banco a cada 500ms. Ao final, todas as wallets são reconciliadas pela API e a invariante global é conferida no banco. Com autenticação ligada, o script obtém os tokens no Keycloak antes da carga (um para criar wallets, outro para as transações).

### Resultados

| Métrica | 1. Antes da otimização | 2. Publisher em lote | 3. Com autenticação |
|---|---|---|---|
| Requisições | 3.772 | 4.247 | 3.548 |
| Throughput | 124,2 req/s | 139,5 req/s | 116,8 req/s |
| Latência p50 / p95 / p99 | 362 / 622 / 793 ms | 320 / 573 / 784 ms | 381 / 679 / 893 ms |
| Taxa de erro | 0% | 0% | 0% |
| Espera média pelo lock | 40,7 ms | 36,6 ms | 38,5 ms |
| Conflitos de lock | 0 | 0 | 0 |
| Outbox: máximo pendente | 2.874 | **562** | 214 |
| Outbox: lag máximo | 25,9 s | **2,55 s** | 1,03 s |
| Drenagem da outbox após a carga | 26,0 s | **1,78 s** | 0,51 s |
| Wallets inconsistentes / divergências no ledger | 0 / 0 | 0 / 0 | 0 / 0 |

### Análise

**Correção sob carga.** Nenhum erro, nenhuma inconsistência e nenhum conflito de lock em todas as rodadas, com 20% do tráfego concentrado numa única wallet. É o resultado que mais importa.

**A latência é dominada por fila, não pelo processamento.** Pela Lei de Little, 50 usuários ÷ 139,5 req/s ≈ 0,36 s — praticamente o p50 medido. O sistema está saturado em vazão, e a latência é tempo de espera. Contribuem para o teto de ~140 req/s: uma única instância da API; cliente e servidor disputando os mesmos 8 threads; a virtualização do Docker Desktop no Windows; e cerca de 6 round-trips ao banco por transação, por causa do flush explícito por operação ([§3](#3-orm-e-estratégia-transacional)).

**A espera pelo lock é pequena em relação à latência total** (~37 ms de média num p50 de 320 ms). A cauda (p95 ≤ 250 ms) vem da hot wallet — é a serialização por wallet aparecendo na métrica, o comportamento esperado. Wallets frias não esperam umas pelas outras.

**Otimização guiada pela medição (rodada 1 → 2).** A primeira rodada mostrou o publisher da outbox como gargalo: ~1,8 eventos por transação geravam ~220 eventos/s, mas os 3 publishers juntos publicavam só ~110/s, porque faziam uma chamada ao SQS por evento. Com `SendMessageBatch` (10 por chamada), o lag máximo caiu de 25,9 s para 2,55 s e a drenagem de 26 s para 1,78 s. O throughput HTTP praticamente não mudou, o que é esperado: o publisher roda no worker, fora do caminho da requisição. Isso confirma que a medição isolou o componente certo.

**Custo da autenticação (rodada 2 → 3).** O throughput caiu ~16% (139,5 → 116,8 req/s) e o p50 subiu ~60 ms. Os motivos prováveis: a verificação de assinatura RS256 em toda requisição, numa única instância da API (as chaves ficam em cache, então o custo é só criptográfico, sem chamada ao Keycloak); o Keycloak, uma JVM, disputando os mesmos 8 threads com a API, o banco e o gerador de carga; e a variação natural entre rodadas, que sem mudança de código já foi de 124 a 139 req/s. A outbox ficou mais folgada porque a vazão menor gera menos eventos por segundo. A correção não mudou.

**Limitações do experimento.** Máquina única, com gerador e sistema competindo por CPU; Docker Desktop no Windows; MiniStack em vez do SQS real; rodadas de 30s, curtas demais para revelar efeitos de longo prazo (crescimento de tabelas, autovacuum); uma rodada por configuração, sem repetições para estimar a variância. Os números são relativos a este ambiente e servem para comparar versões, não como capacidade de produção.

**Próximos passos de desempenho:** escalar a API horizontalmente (o desenho já suporta); reduzir round-trips agrupando os inserts da transação num único flush; medir com o gerador de carga e o Keycloak em outra máquina; repetir cada rodada algumas vezes.

## 18. Limitações e próximos passos

- **Autorização granular:** as rotas de wallet aceitam qualquer client autenticado, e `GET /wagering/transactions/:transactionId` não confere se a transação é do provedor do token. Em produção, as operações de wallet exigiriam um papel ou escopo do backoffice (ex. `wallet:write`), e a consulta por id interno seria restrita ao provedor dono da transação.
- **Segredos do Keycloak no repositório:** os secrets dos clients estão fixos no realm importado, por ser um ambiente local de demonstração. Em produção viriam de um gerenciador de segredos, e o realm não seria importado em modo `start-dev`.
- **Readiness não verifica o Keycloak:** se o IdP ficar fora do ar, a API continua validando tokens com as chaves em cache; só uma rotação de chaves durante a indisponibilidade causaria erro (503). Um check opcional do JWKS no `/health/ready` deixaria isso visível.
- **Round-trips por transação:** o flush explícito por operação garante a ordem dos INSERTs sem relações ORM, mas custa latência. Um flush único com a ordem garantida (por relações ORM declaradas, ou constraints `DEFERRABLE`) reduziria os round-trips.
- **A outbox segura a transação durante a publicação.** O claim com `SKIP LOCKED` mantém o lock enquanto o lote é enviado ao SQS. Com alto volume, um modelo de *lease* (marcar `claimed_until`, commitar, publicar, confirmar) liberaria o banco mais cedo.
- **Ordem dos eventos sob falha:** se uma publicação falha e é reagendada enquanto eventos posteriores da mesma wallet são publicados, a ordem se inverte. Os consumidores devem usar `walletVersion` (presente em `WalletBalanceChanged`) para ordenar e deduplicar.
- **DLQ não atômica:** o envio à DLQ e a remoção da fila principal são duas chamadas. Um crash entre elas pode duplicar a mensagem na DLQ (a deduplicação do FIFO, por `MessageId`, cobre a janela de 5 minutos).
- **Status `FAILED` reservado:** nenhum fluxo o atinge hoje (ver [§9](#9-regras-de-negócio-e-interpretações)). Um caminho natural seria um processo que reidrata mensagens da DLQ e grava a transação como `FAILED` assim que o banco estiver disponível, unificando a auditoria num lugar só.
- **Reprocessamento imediato de pendentes:** hoje uma transação `PENDING_REFERENCE` espera o próximo ciclo do worker (~1s) mesmo que a referência chegue logo em seguida. Disparar o reprocessamento logo após o commit da referência reduziria essa latência; o índice `wager_tx_waiting_reference_idx` já existe para essa busca.
- **Reconciliação trava a wallet** brevemente para ler saldo e ledger no mesmo instante lógico. Em uma hot wallet, concorre com o processamento.
- **MiniStack vs SQS real:** comportamentos como `PurgeQueue` (com cooldown de 60s na AWS) e a `RedrivePolicy` podem diferir. A DLQ conduzida pela aplicação reduz essa dependência.
- **Imagem Docker única** com dependências de desenvolvimento (o CLI de migrations é devDependency). Uma imagem de produção em múltiplos estágios seria o passo seguinte.
- **Métricas por processo:** cada instância expõe as suas; a agregação fica a cargo do Prometheus. Não há dashboard nem OpenTelemetry (opcionais no enunciado).
- **Fora de escopo, conforme o enunciado:** reversão parcial e ledger de partidas dobradas.