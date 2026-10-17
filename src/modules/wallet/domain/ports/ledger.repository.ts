import type { Money } from '../../../../shared/domain/money';
import type { WalletLedgerEntry } from '../wallet-ledger-entry';

export interface LedgerTotals {
  calculatedBalance: Money;
  entries: number;
}

export abstract class LedgerRepository {
  abstract add(entry: WalletLedgerEntry): Promise<void>;
  abstract listByWallet(
    walletId: string,
    options: { afterVersion?: number; limit: number },
  ): Promise<WalletLedgerEntry[]>;
  abstract totalsByWallet(walletId: string, currency: string): Promise<LedgerTotals>;
}