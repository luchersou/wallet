import { describe, expect, it } from 'bun:test';
import { Money, type MoneyProps } from '../../src/shared/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/money.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('from', () => {
    it('parses and serializes with fixed scale', () => {
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(brl('0.01').amount).toBe('0.01');
      expect(brl('0.00').isZero()).toBe(true);
    });

    it('accepts the maximum supported magnitude', () => {
      expect(brl('99999999999999999.99').amount).toBe('99999999999999999.99');
    });

    it.each([
      [''],
      ['25'],
      ['25.5'],
      ['25.555'],
      ['-1.00'],
      ['+1.00'],
      ['1e3'],
      ['1.5e2'],
      ['NaN'],
      ['Infinity'],
      ['-Infinity'],
      [' 1.00'],
      ['1.00 '],
      ['01.00'],
      ['1,00'],
      ['.50'],
      ['100000000000000000.00'],
    ])('rejects invalid amount %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it.each([[25], [25.5], [null], [undefined], [{}]])('rejects non-string amount %p', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' } as unknown as MoneyProps)).toThrow(
        InvalidMoneyError,
      );
    });

    it.each([[''], ['brl'], ['BR'], ['BRLL'], ['B1L'], [null]])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency } as unknown as MoneyProps)).toThrow(
        InvalidMoneyError,
      );
    });

    it('rejects non-object input', () => {
      expect(() => Money.from(null as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('is exact where floating point is not', () => {
      expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    });

    it('keeps exactness over many operations', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
      expect(total.amount).toBe('10.00');
    });

    it('subtracts and may produce negative results internally', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.amount).toBe('-60.00');
      expect(result.isNegative()).toBe(true);
    });

    it('negates', () => {
      expect(brl('5.00').negate().amount).toBe('-5.00');
      expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
    });

    it('normalizes negative zero', () => {
      expect(Money.zero('BRL').negate().amount).toBe('0.00');
      expect(brl('5.00').subtract(brl('5.00')).amount).toBe('0.00');
    });

    it('rejects results beyond supported magnitude', () => {
      const max = brl('99999999999999999.99');
      expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    });

    it('is immutable', () => {
      const a = brl('10.00');
      const b = brl('5.00');
      a.add(b);
      a.subtract(b);
      a.negate();
      expect(a.amount).toBe('10.00');
      expect(b.amount).toBe('5.00');
    });
  });

  describe('comparisons', () => {
    it('classifies sign', () => {
      expect(brl('1.00').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);
    });

    it('compares values', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    });

    it('compares equality by value, not representation', () => {
      expect(brl('10.00').equals(brl('10.00'))).toBe(true);
      expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    });
  });

  describe('currency conflicts', () => {
    it('throws on cross-currency operations', () => {
      expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('treats different currencies as not equal without throwing', () => {
      expect(brl('1.00').equals(usd('1.00'))).toBe(false);
    });

    it('zero validates currency', () => {
      expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
    });
  });

  describe('serialization', () => {
    it('serializes to MoneyProps in JSON', () => {
      expect(JSON.stringify({ money: brl('975.00') })).toBe(
        '{"money":{"amount":"975.00","currency":"BRL"}}',
      );
    });

    it('has a readable string form', () => {
      expect(brl('975.00').toString()).toBe('975.00 BRL');
    });
  });
});