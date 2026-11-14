import { Global, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from '../../mikro-orm.config';
import { Clock } from '../shared/application/ports/clock.port';
import { IdGenerator } from '../shared/application/ports/id-generator.port';
import { TransactionRunner } from '../shared/application/ports/transaction-runner.port';
import { MikroOrmTransactionRunner } from '../shared/infrastructure/persistence/mikro-orm-transaction-runner';
import { SystemClock } from '../shared/infrastructure/system-clock';
import { UuidV7Generator } from '../shared/infrastructure/uuid-v7-generator';
import { LedgerRepository } from '../modules/wallet/domain/ports/ledger.repository';
import { WalletRepository } from '../modules/wallet/domain/ports/wallet.repository';
import { MikroOrmLedgerRepository } from '../modules/wallet/infrastructure/persistence/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from '../modules/wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { WagerTransactionRepository } from '../modules/wagering/domain/ports/wager-transaction.repository';
import { MikroOrmWagerTransactionRepository } from '../modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { InboxRepository } from '../modules/messaging/application/ports/inbox.repository';
import { OutboxRepository } from '../modules/messaging/application/ports/outbox.repository';
import { MikroOrmInboxRepository } from '../modules/messaging/infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../modules/messaging/infrastructure/persistence/mikro-orm-outbox.repository';

/**
 * Shared infra: ORM, repositories (ports → adapters), runner, clock and ids.
 * Global to avoid circular dependencies between feature modules.
 */
@Global()
@Module({
  imports: [MikroOrmModule.forRoot(config)],
  providers: [
    { provide: TransactionRunner, useClass: MikroOrmTransactionRunner },
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    { provide: WalletRepository, useClass: MikroOrmWalletRepository },
    { provide: LedgerRepository, useClass: MikroOrmLedgerRepository },
    { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
    { provide: InboxRepository, useClass: MikroOrmInboxRepository },
    { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
  ],
  exports: [
    TransactionRunner, Clock, IdGenerator,
    WalletRepository, LedgerRepository, WagerTransactionRepository,
    InboxRepository, OutboxRepository,
  ],
})
export class CoreModule {}