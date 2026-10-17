import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

/** Instância isolada do Decimal: não depende de configuração global. */
const Dec = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

const SCALE = 2;
/** Até 17 dígitos inteiros + 2 decimais = numeric(19,2) do banco. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ABSOLUTE = new Dec('99999999999999999.99');

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Contrato de entrada: string decimal não negativa com exatamente 2 casas.
   * Rejeita NaN, Infinity, notação científica, vazio, sinal, separador errado.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }

    const { amount, currency } = props;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount}" must be a non-negative decimal with exactly ${SCALE} places`,
      );
    }
    Money.assertValidCurrency(currency);

    return new Money(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Dec(0), currency);
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Igualdade de valor: moedas diferentes simplesmente não são iguais. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  /** Resultados internos de operações: podem ser negativos (ex.: diferença na reconciliação). */
  private static of(value: Decimal, currency: string): Money {
    if (value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError(`result exceeds ${SCALE} decimal places`);
    }
    if (value.abs().greaterThan(MAX_ABSOLUTE)) {
      throw new InvalidMoneyError('result exceeds supported magnitude');
    }
    // Normaliza -0 para 0
    const normalized = value.isZero() ? new Dec(0) : value;
    return new Money(normalized, currency);
  }

  private static assertValidCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" must be an ISO-4217 code`);
    }
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}