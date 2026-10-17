import { describe, expect, it } from 'bun:test';
import { InvariantViolationError } from '../../src/shared/domain/invariant-violation.error';
import { Money } from '../../src/shared/domain/money';
import { CurrencyMismatchError } from '../../src/shared/domain/money.errors';
import { LedgerDirection } from '../../src/modules/wallet/domain/ledger-direction';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { InsufficientFundsError } from '../../src/modules/wallet/domain/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-10-15T12:00:00Z');

let seq = 0;
const movement = (money: Money) => {
  seq++;
  return { money, transactionId: `tx-${seq}`, ledgerEntryId: `entry-${seq}`, at };
};

const openWallet = (initial: string) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingLedgerEntryId: 'entry-opening',
    at,
  });

describe('Wallet', () => {
  describe('open', () => {
    it('opens with positive balance, version 1 and an opening credit', () => {
      const { wallet, openingEntry } = openWallet('1000.00');

      expect(wallet.balance.amount).toBe('1000.00');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeDefined();
      expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry!.balanceBefore.amount).toBe('0.00');
      expect(openingEntry!.balanceAfter.amount).toBe('1000.00');
      expect(openingEntry!.walletVersion).toBe(1);
      expect(openingEntry!.transactionId).toBe('tx-opening');
    });

    it('opens with zero balance and no ledger entry', () => {
      const { wallet, openingEntry } = openWallet('0.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.isZero()).toBe(true);
      expect(openingEntry).toBeUndefined();
    });

    it('rejects missing identity', () => {
      expect(() =>
        Wallet.open({
          id: '',
          playerId: 'player-1',
          initialBalance: brl('1.00'),
          openingTransactionId: 'tx',
          openingLedgerEntryId: 'entry',
          at,
        }),
      ).toThrow(InvariantViolationError);
    });
  });

  describe('debit', () => {
    it('debits, bumps version and returns a matching entry', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.debit(movement(brl('80.00')));

      expect(wallet.balance.amount).toBe('20.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.amount).toBe('100.00');
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.walletVersion).toBe(wallet.version);
      expect(entry.isBalanced()).toBe(true);
    });

    it('allows debiting the exact balance', () => {
      const { wallet } = openWallet('80.00');
      wallet.debit(movement(brl('80.00')));
      expect(wallet.balance.amount).toBe('0.00');
    });

    it('rejects insufficient funds without changing state', () => {
      const { wallet } = openWallet('100.00');
      wallet.debit(movement(brl('80.00')));

      expect(wallet.canDebit(brl('80.00'))).toBe(false);
      expect(() => wallet.debit(movement(brl('80.00')))).toThrow(InsufficientFundsError);
      expect(wallet.balance.amount).toBe('20.00');
      expect(wallet.version).toBe(2);
    });
  });

  describe('credit', () => {
    it('credits and bumps version', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.credit(movement(brl('50.00')));

      expect(wallet.balance.amount).toBe('150.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });
  });

  describe('guards', () => {
    it('rejects currency mismatch without changing state', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.debit(movement(usd('10.00')))).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(movement(usd('10.00')))).toThrow(CurrencyMismatchError);
      expect(() => wallet.canDebit(usd('10.00'))).toThrow(CurrencyMismatchError);
      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects non-positive movements without changing state', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvariantViolationError);
      expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvariantViolationError);
      expect(wallet.version).toBe(1);
    });
  });

  describe('ledger consistency', () => {
    it('produces a chained ledger whose replay equals the balance', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      const entries = [
        openingEntry!,
        wallet.debit(movement(brl('25.00'))),
        wallet.credit(movement(brl('40.00'))),
        wallet.debit(movement(brl('115.00'))),
        wallet.credit(movement(brl('0.01'))),
      ];

      entries.forEach((entry, i) => {
        expect(entry.walletVersion).toBe(i + 1);
        if (i > 0) expect(entry.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
      });

      const replayed = entries.reduce(
        (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
        Money.zero('BRL'),
      );
      expect(replayed.equals(wallet.balance)).toBe(true);
      expect(wallet.balance.amount).toBe('0.01');
      expect(wallet.version).toBe(5);
    });
  });

  describe('rehydrate', () => {
    it('restores state without revalidating', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('975.00'),
        version: 7,
        createdAt: at,
        updatedAt: at,
      });
      expect(wallet.balance.amount).toBe('975.00');
      expect(wallet.version).toBe(7);
      expect(wallet.toState().version).toBe(7);
    });
  });
});