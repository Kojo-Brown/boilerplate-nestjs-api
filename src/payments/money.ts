/**
 * Money is carried in minor units (cents, pence, sen) everywhere in the domain,
 * because that is the only representation every provider agrees on and the only
 * one that survives arithmetic. Stripe's API is already minor-unit; PayPal's is
 * a decimal string, so the PayPal adapter converts at the wire boundary and
 * nowhere else.
 */
export interface Money {
  /** Integer number of minor units. Always >= 0. */
  readonly amountMinor: number;
  /** Upper-case ISO 4217 alphabetic code. */
  readonly currency: string;
}

/**
 * Currencies whose minor unit is not 1/100.
 *
 * PayPal rejects a decimal fraction on these outright ("DECIMAL_PRECISION"), so
 * `1000 JPY` has to go out as `"1000"`, not `"10.00"`. The list is the
 * zero-decimal set PayPal documents; anything absent is assumed to have two
 * decimal places, which is true of every other currency either provider takes.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["HUF", "JPY", "TWD"]);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

/**
 * Validates and normalises an amount at the edge of the payments domain.
 *
 * Providers call this before touching the network so a malformed amount fails
 * as a local error with a useful message rather than as an opaque 400 from
 * Stripe three hops later.
 */
export function normaliseMoney(money: Money): Money {
  const currency = money.currency.toUpperCase();

  if (!CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(
      `Currency must be a 3-letter ISO 4217 code, received "${money.currency}"`,
    );
  }
  if (!Number.isInteger(money.amountMinor)) {
    throw new InvalidMoneyError(
      `Amount must be an integer number of minor units, received ${money.amountMinor}`,
    );
  }
  if (money.amountMinor < 0) {
    throw new InvalidMoneyError(`Amount must not be negative, received ${money.amountMinor}`);
  }

  return { amountMinor: money.amountMinor, currency };
}

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Renders minor units as the decimal string PayPal's `value` field expects.
 *
 * Done with integer arithmetic and string padding rather than a division, so
 * `2350 JPY -> "2350"` and `2350 EUR -> "23.50"` without ever going through a
 * float that could render `23.499999999999996`.
 */
export function toDecimalString(money: Money): string {
  const { amountMinor, currency } = normaliseMoney(money);
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) return String(amountMinor);

  const digits = String(amountMinor).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * Parses a provider decimal string back into minor units.
 *
 * Also integer-only: `Math.round(Number("23.50") * 100)` is correct for most
 * values and quietly wrong for a few (`Number("1.005") * 100` is 100.49999…),
 * and "a few" is not an acceptable error rate for money.
 */
export function fromDecimalString(value: string, currency: string): Money {
  const normalisedCurrency = currency.toUpperCase();
  if (!CURRENCY_PATTERN.test(normalisedCurrency)) {
    throw new InvalidMoneyError(
      `Currency must be a 3-letter ISO 4217 code, received "${currency}"`,
    );
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new InvalidMoneyError(`Amount "${value}" is not a decimal number`);
  }

  const exponent = minorUnitExponent(normalisedCurrency);
  const [, whole, fraction = ""] = match;
  if (fraction.length > exponent) {
    throw new InvalidMoneyError(
      `Amount "${value}" has more precision than ${normalisedCurrency} allows (${exponent} dp)`,
    );
  }

  const minor = `${whole}${fraction.padEnd(exponent, "0")}`;
  return { amountMinor: Number(minor), currency: normalisedCurrency };
}

export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency.toUpperCase() === b.currency.toUpperCase();
}
