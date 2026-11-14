import { Money } from '../../domain/money';

/** The pg driver returns numeric as a string ("975.00") — it never goes through number. */
export const toMoney = (amount: string, currency: string): Money =>
  Money.from({ amount, currency: currency.trim() });

/** For aggregations that may be negative (e.g. sum of a corrupted ledger). */
export const toSignedMoney = (amount: string, currency: string): Money =>
  amount.startsWith('-')
    ? toMoney(amount.slice(1), currency).negate()
    : toMoney(amount, currency);