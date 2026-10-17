import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da wallet produzida por este lançamento (sequência por wallet). */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter, walletVersion } = props;

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvariantViolationError('ledger entry mixes currencies');
    }
    if (!money.isPositive()) {
      throw new InvariantViolationError('ledger entry amount must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry balances must be non-negative');
    }
    if (!Number.isInteger(walletVersion) || walletVersion < 1) {
      throw new InvariantViolationError('ledger entry walletVersion must be a positive integer');
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `ledger arithmetic broken: ${balanceBefore.toString()} ${props.direction} ` +
          `${money.toString()} != ${balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}