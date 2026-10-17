import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';

export const createTestOrm = () => MikroORM.init({ ...config, debug: false });

export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute(
    `truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade`,
  );
}