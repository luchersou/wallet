import { describe, expect, it } from 'bun:test';
import { InvariantViolationError } from '../../src/shared/domain/invariant-violation.error';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/modules/wallet/domain/ledger-direction';
import {
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../src/modules/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const baseProps = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  walletVersion: 2,
  createdAt: new Date('2026-10-15T12:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create(baseProps());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.amount).toBe('20.00');
  });

  it('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      baseProps({ direction: LedgerDirection.Credit, balanceAfter: brl('180.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects broken arithmetic', () => {
    expect(() => WalletLedgerEntry.create(baseProps({ balanceAfter: brl('21.00') }))).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects direction inconsistent with balances', () => {
    expect(() =>
      WalletLedgerEntry.create(baseProps({ direction: LedgerDirection.Credit })),
    ).toThrow(InvariantViolationError);
  });

  it('rejects non-positive amounts', () => {
    expect(() =>
      WalletLedgerEntry.create(
        baseProps({ money: brl('0.00'), balanceAfter: brl('100.00') }),
      ),
    ).toThrow(InvariantViolationError);
  });

  it('rejects negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create(
        baseProps({ money: brl('120.00'), balanceAfter: brl('100.00').subtract(brl('120.00')) }),
      ),
    ).toThrow(InvariantViolationError);
  });

  it('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create(baseProps({ money: usd('80.00') }))).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects invalid wallet version', () => {
    expect(() => WalletLedgerEntry.create(baseProps({ walletVersion: 0 }))).toThrow(
      InvariantViolationError,
    );
    expect(() => WalletLedgerEntry.create(baseProps({ walletVersion: 1.5 }))).toThrow(
      InvariantViolationError,
    );
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(baseProps());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });

  it('rehydrate does not validate, but isBalanced detects corruption', () => {
    const corrupted = WalletLedgerEntry.rehydrate(baseProps({ balanceAfter: brl('99.00') }));
    expect(corrupted.isBalanced()).toBe(false);
  });
});