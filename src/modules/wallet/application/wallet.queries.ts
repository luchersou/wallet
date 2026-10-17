import { Injectable } from '@nestjs/common';
import type { MoneyProps } from '../../../shared/domain/money';
import { LedgerRepository } from '../domain/ports/ledger.repository';
import { WalletRepository } from '../domain/ports/wallet.repository';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletNotFoundError } from '../domain/wallet.errors';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import { toWalletView, type WalletView } from './open-wallet.use-case';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

const toLedgerEntryView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

@Injectable()
export class WalletQueries {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);

    const afterVersion = cursor ? decodeLedgerCursor(cursor) : undefined;
    const entries = await this.ledger.listByWallet(walletId, { afterVersion, limit: limit + 1 });
    const page = entries.slice(0, limit);
    const last = page.at(-1);

    return {
      items: page.map(toLedgerEntryView),
      nextCursor: entries.length > limit && last ? encodeLedgerCursor(last.walletVersion) : null,
    };
  }
}