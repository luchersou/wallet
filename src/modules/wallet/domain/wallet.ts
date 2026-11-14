import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';
import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/money.errors';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Used only if initialBalance > 0 (OPENING transaction + entry). */
  openingTransactionId: string;
  openingLedgerEntryId: string;
  at: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export interface BalanceMovement {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Creates the wallet with version = 1. If the initial balance is positive, returns the
   * opening CREDIT entry (0 → initial balance) with walletVersion = 1.
   */
  static open(props: OpenWalletProps): OpenWalletResult {
    if (!props.id || !props.playerId) {
      throw new InvariantViolationError('wallet requires id and playerId');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('initial balance cannot be negative');
    }

    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );

    if (props.initialBalance.isZero()) {
      return { wallet };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingLedgerEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });

    return { wallet, openingEntry };
  }

  /** Rehydration from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id, this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  /** Creates the entry BEFORE mutating: if validation fails, the wallet stays intact. */
  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);
    const nextVersion = this._version + 1;

    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = movement.at;

    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError('balance movement must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}