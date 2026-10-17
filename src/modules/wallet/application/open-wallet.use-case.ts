import { Injectable } from '@nestjs/common';
import { UniqueConstraintConflictError } from '../../../shared/application/errors';
import { Clock } from '../../../shared/application/ports/clock.port';
import { IdGenerator } from '../../../shared/application/ports/id-generator.port';
import { TransactionRunner } from '../../../shared/application/ports/transaction-runner.port';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { payloadHash } from '../../../shared/infrastructure/crypto/payload-hash';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import { WagerTransactionProcessed } from '../../wagering/domain/events/wager-transaction-processed.event';
import { WalletBalanceChanged } from '../../wagering/domain/events/wallet-balance-changed.event';
import { WagerTransactionRepository } from '../../wagering/domain/ports/wager-transaction.repository';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { LedgerRepository } from '../domain/ports/ledger.repository';
import { WalletRepository } from '../domain/ports/wallet.repository';
import { Wallet } from '../domain/wallet';
import { WalletAlreadyExistsError } from '../domain/wallet.errors';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (w: Wallet): WalletView => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

@Injectable()
export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly txs: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);

    try {
      return await this.runner.run(async () => {
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTxId = this.ids.next();

        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance,
          openingTransactionId: openingTxId,
          openingLedgerEntryId: this.ids.next(),
          at: now,
        });

        await this.wallets.add(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTxId,
            walletId,
            playerId: cmd.playerId,
            money: initialBalance,
            payloadHash: payloadHash({ walletId, initialBalance: initialBalance.toJSON() }),
            at: now,
          });
          const ctx = {
            correlationId: cmd.correlationId,
            occurredAt: now,
            nextId: () => this.ids.next(),
          };

          await this.txs.add(opening);
          await this.ledger.add(openingEntry);
          await this.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)));
          await this.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)));
        }

        return toWalletView(wallet);
      });
    } catch (err) {
      if (err instanceof UniqueConstraintConflictError) {
        throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
      }
      throw err;
    }
  }
}