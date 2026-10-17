import { Money } from '../../domain/money';

/** O driver pg devolve numeric como string ("975.00") — nunca passa por number. */
export const toMoney = (amount: string, currency: string): Money =>
  Money.from({ amount, currency: currency.trim() });

/** Para agregações que podem ser negativas (ex.: soma do ledger corrompido). */
export const toSignedMoney = (amount: string, currency: string): Money =>
  amount.startsWith('-')
    ? toMoney(amount.slice(1), currency).negate()
    : toMoney(amount, currency);