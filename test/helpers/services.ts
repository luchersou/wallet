import type { MikroORM } from '@mikro-orm/postgresql';
import { SystemClock } from '../../src/shared/infrastructure/system-clock';
import { UuidV7Generator } from '../../src/shared/infrastructure/uuid-v7-generator';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/persistence/mikro-orm-transaction-runner';
import { MikroOrmWalletRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { MikroOrmInboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm-outbox.repository';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { RetryPendingReference } from '../../src/modules/wagering/application/retry-pending-reference.use-case';
import { WagerTransactionProcessor } from '../../src/modules/wagering/application/wager-transaction-processor';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry-policy';
import { NoopMetrics } from '../../src/shared/application/ports/metrics.port';

/** Monta os casos de uso sem Nest, contra Postgres real. */
export function buildServices(orm: MikroORM, policy = new ReferenceRetryPolicy(3, 5, 20)) {
  const runner = new MikroOrmTransactionRunner(orm.em);
  const wallets = new MikroOrmWalletRepository(orm.em);
  const ledger = new MikroOrmLedgerRepository(orm.em);
  const txs = new MikroOrmWagerTransactionRepository(orm.em);
  const inbox = new MikroOrmInboxRepository(orm.em);
  const outbox = new MikroOrmOutboxRepository(orm.em);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const processor = new WagerTransactionProcessor(txs, wallets, ledger, outbox, ids, policy);

  return {
    orm, runner, wallets, ledger, txs, inbox, outbox, policy,
    openWallet: new OpenWallet(runner, wallets, ledger, txs, outbox, ids, clock),
    processWager: new ProcessWagerTransaction(runner, wallets, txs, inbox, processor, ids, clock, new NoopMetrics()),
    retryPending: new RetryPendingReference(runner, wallets, txs, processor, ids, clock),
  };
}

export type Services = ReturnType<typeof buildServices>;

/** Invariante final: wallet.balance == saldo reconstruído pelo ledger. */
export async function assertLedgerInvariant(s: Services, walletId: string): Promise<void> {
  const { wallet, totals } = await s.runner.run(async () => {
    const wallet = await s.wallets.findById(walletId);
    if (!wallet) throw new Error(`wallet ${walletId} not found`);
    return { wallet, totals: await s.ledger.totalsByWallet(walletId, wallet.currency) };
  });
  if (!totals.calculatedBalance.equals(wallet.balance)) {
    throw new Error(
      `ledger invariant broken: stored ${wallet.balance.toString()} vs ledger ${totals.calculatedBalance.toString()}`,
    );
  }
}

export async function countOutbox(s: Services, eventType: string): Promise<number> {
  const rows = (await s.orm.em.getConnection().execute(
    `select count(*)::int as n from outbox_messages where event_type = ?`,
    [eventType],
  )) as { n: number }[];
  return rows[0]?.n ?? 0;
}

export async function countLedger(s: Services, walletId: string): Promise<number> {
  const rows = (await s.orm.em.getConnection().execute(
    `select count(*)::int as n from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  )) as { n: number }[];
  return rows[0]?.n ?? 0;
}