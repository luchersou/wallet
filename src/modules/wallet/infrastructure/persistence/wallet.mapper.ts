import { toMoney } from '../../../../shared/infrastructure/persistence/money.mapper';
import { LedgerDirection } from '../../domain/ledger-direction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerEntryRecord } from './ledger-entry.schema';
import { WalletRecord } from './wallet.schema';

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: toMoney(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },

  toNewRecord(wallet: Wallet): WalletRecord {
    const s = wallet.toState();
    return Object.assign(new WalletRecord(), {
      id: s.id,
      playerId: s.playerId,
      currency: s.currency,
      balance: s.balance.amount,
      version: s.version,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  },

  /** Só os campos mutáveis do agregado. */
  apply(wallet: Wallet, record: WalletRecord): void {
    record.balance = wallet.balance.amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: toMoney(r.amount, r.currency),
      balanceBefore: toMoney(r.balanceBefore, r.currency),
      balanceAfter: toMoney(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },

  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return Object.assign(new LedgerEntryRecord(), {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    });
  },
};