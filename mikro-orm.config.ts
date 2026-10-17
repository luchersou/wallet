import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from './src/modules/wallet/infrastructure/persistence/wallet.schema';
import { LedgerEntrySchema } from './src/modules/wallet/infrastructure/persistence/ledger-entry.schema';
import { WagerTransactionSchema } from './src/modules/wagering/infrastructure/persistence/wager-transaction.schema';
import { InboxSchema, OutboxSchema } from './src/modules/messaging/infrastructure/persistence/messaging.schema';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? 'wallet',
  password: process.env.DB_PASSWORD ?? 'wallet',
  dbName: process.env.DB_NAME ?? 'wallet',
  entities: [WalletSchema, LedgerEntrySchema, WagerTransactionSchema, InboxSchema, OutboxSchema],
  forceUtcTimezone: true,
  extensions: [Migrator],
  migrations: {
    path: './migrations',
    pathTs: './migrations',
    transactional: true,
    allOrNothing: true,
    snapshot: false,
    emit: 'ts',
  },
  debug: process.env.NODE_ENV === 'development',
});