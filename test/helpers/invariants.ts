import type { MikroORM } from '@mikro-orm/core';

/**
 * Invariante final do enunciado: wallet.balance == saldo reconstruído pelo ledger,
 * para TODAS as wallets do banco, e nenhum saldo negativo.
 */
export async function assertGlobalLedgerInvariant(orm: MikroORM): Promise<void> {
  const divergent = (await orm.em.getConnection().execute(
    `select w.id,
            w.balance::text as stored,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as ledger
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      group by w.id, w.balance
     having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)
         or w.balance < 0`,
  )) as { id: string; stored: string; ledger: string }[];

  if (divergent.length > 0) {
    throw new Error(`ledger invariant broken for ${divergent.length} wallet(s): ${JSON.stringify(divergent)}`);
  }
}