import fc from "fast-check";
import { configureFastCheck } from "@/test-utils/fast-check";
import {
  InvalidMoneyError,
  type Money,
  fromDecimalString,
  minorUnitExponent,
  normaliseMoney,
  sameCurrency,
  toDecimalString,
} from "./money";

/**
 * Property-based tests for the money helpers.
 *
 * `money.spec.ts` covers the cases somebody thought of: 2350 EUR, 2350 JPY, a
 * fractional amount, a four-letter currency. Those are the inputs the author
 * of the function had in mind, which is exactly the set least likely to
 * contain the bug. What a property test adds is the inputs nobody had in mind
 * — and it found two of them here, both of which are now guarded in `money.ts`
 * and pinned by an example in `money.spec.ts`:
 *
 *  - `toDecimalString({ amountMinor: 1e21, currency: "EUR" })` returned
 *    `"1e+.21"`. `Number.isInteger(1e21)` is true, so the amount passed
 *    validation; `String(1e21)` is `"1e+21"`, and the padding-and-slicing
 *    then treats the exponent as digits. That string was the `value` field of
 *    a PayPal capture request.
 *  - `fromDecimalString("99999999999999999999.99", "EUR")` returned
 *    `1e22` minor units — a rounded amount, accepted silently, which is the
 *    one thing the module's own comments say integer arithmetic is there to
 *    prevent.
 *
 * The properties below are the invariants those bugs broke, stated over the
 * whole input space rather than over a list of values. They are run with a
 * fixed seed; see `src/test-utils/fast-check.ts` for why, and for how to soak
 * them with a different one.
 */
configureFastCheck();

/** The documented zero-decimal set, restated here so the property can check it. */
const ZERO_DECIMAL = ["HUF", "JPY", "TWD"] as const;

/**
 * Any ISO 4217-shaped code, weighted so the zero-decimal branch is taken often
 * enough to matter: three codes out of 17,576 would otherwise show up roughly
 * never, and every interesting difference in this module is on that branch.
 */
const currency: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(...ZERO_DECIMAL) },
  { weight: 2, arbitrary: fc.stringMatching(/^[A-Z]{3}$/) },
);

/**
 * Realistic amounts most of the time, the whole representable range sometimes.
 * The upper bound is `Number.MAX_SAFE_INTEGER`, which is where `normaliseMoney`
 * now stops: above it `String()` switches to exponent notation and the integer
 * arithmetic stops being integer arithmetic.
 */
const amountMinor: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.nat({ max: 10_000_000 }) },
  { weight: 1, arbitrary: fc.maxSafeNat() },
);

const money: fc.Arbitrary<Money> = fc.record({ amountMinor, currency });

/**
 * Every non-negative amount `Number.isInteger` is true of — which is a wider
 * set than the one that can be represented exactly, and deliberately so. The
 * properties that bound the output have to generate what the input validation
 * *accepts*, not what it ought to accept, or they are only ever asked about
 * values the fix already allows. `1e21` is in here, and it is how the
 * `"1e+.21"` bug reproduces.
 */
const integralAmount: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: amountMinor },
  {
    weight: 1,
    arbitrary: fc
      .double({ min: 2 ** 53, max: 1e30, noNaN: true, noDefaultInfinity: true })
      .map(Math.round),
  },
);

/** Whitespace a provider's JSON field might carry around the value. */
const whitespace = fc.constantFrom("", " ", "  ", "\n", "\t");

/**
 * A decimal string shaped the way a provider sends one: optional leading
 * zeros, an optional fraction no longer than the currency allows.
 */
function decimalFor(code: string): fc.Arbitrary<string> {
  const exponent = minorUnitExponent(code);
  const digit = fc.constantFrom(..."0123456789".split(""));
  const fraction =
    exponent === 0
      ? fc.constant("")
      : fc.option(
          fc
            .array(digit, { minLength: 1, maxLength: exponent })
            .map((digits) => `.${digits.join("")}`),
          { nil: "" },
        );
  return fc
    .tuple(fc.stringMatching(/^0{0,3}$/), fc.nat({ max: 999_999_999 }), fraction)
    .map(([zeros, whole, decimals]) => `${zeros}${whole}${decimals}`);
}

/** Runs `call`, returning either its result or the error it threw. */
function outcomeOf<T>(call: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: call() };
  } catch (error) {
    return { ok: false, error };
  }
}

describe("money (properties)", () => {
  it("normalises to an upper-case code and is idempotent", () => {
    fc.assert(
      fc.property(amountMinor, fc.mixedCase(currency), (amount, code) => {
        const once = normaliseMoney({ amountMinor: amount, currency: code });

        expect(once).toEqual({ amountMinor: amount, currency: code.toUpperCase() });
        // Idempotence is what makes it safe for every provider to call this at
        // its own boundary without caring whether an earlier layer already did.
        expect(normaliseMoney(once)).toEqual(once);
      }),
    );
  });

  it("round-trips every amount it accepts through its decimal string", () => {
    // The property the two bugs broke. `toDecimalString` is the wire format and
    // `fromDecimalString` reads it back: if the pair is not the identity, some
    // amount is charged, refunded or reconciled as a different amount.
    //
    // Stated over everything `normaliseMoney` accepts rather than over
    // everything it *should* accept, which is what gives the generator room to
    // reach 1e21 and the property its teeth: refusing an amount satisfies it,
    // rendering one that cannot be read back does not.
    fc.assert(
      fc.property(integralAmount, currency, (amount, code) => {
        const accepted = outcomeOf(() => normaliseMoney({ amountMinor: amount, currency: code }));
        if (!accepted.ok) {
          expect(accepted.error).toBeInstanceOf(InvalidMoneyError);
          return;
        }

        const rendered = toDecimalString(accepted.value);

        expect(rendered).toMatch(/^\d+(?:\.\d+)?$/);
        expect(fromDecimalString(rendered, code)).toEqual(accepted.value);
      }),
    );
  });

  it("renders digits only, with the currency's own number of decimal places", () => {
    fc.assert(
      fc.property(integralAmount, currency, (amount, code) => {
        const accepted = outcomeOf(() => normaliseMoney({ amountMinor: amount, currency: code }));
        if (!accepted.ok) return;

        const rendered = toDecimalString(accepted.value);
        const exponent = minorUnitExponent(code);

        expect(rendered).toMatch(exponent === 0 ? /^\d+$/ : /^\d+\.\d{2}$/);
        // And the digits are the minor units, unchanged: no float ever touched
        // them. `"1e+.21"` satisfied neither half of this.
        expect(rendered.replace(".", "").replace(/^0+(?=\d)/, "")).toBe(
          String(accepted.value.amountMinor),
        );
      }),
    );
  });

  it("distinguishes every pair of distinct amounts", () => {
    // Injectivity per currency. A renderer that collapsed two amounts onto one
    // string would round-trip fine for one of them and silently mis-charge the
    // other.
    fc.assert(
      fc.property(amountMinor, amountMinor, currency, (first, second, code) => {
        fc.pre(first !== second);

        expect(toDecimalString({ amountMinor: first, currency: code })).not.toBe(
          toDecimalString({ amountMinor: second, currency: code }),
        );
      }),
    );
  });

  it("reads a provider's string the same way however it is padded", () => {
    fc.assert(
      fc.property(
        currency.chain((code) =>
          fc.tuple(fc.constant(code), decimalFor(code), whitespace, whitespace),
        ),
        ([code, value, before, after]) => {
          const parsed = fromDecimalString(value, code);

          // Surrounding whitespace and leading zeros are formatting, not value.
          expect(fromDecimalString(`${before}${value}${after}`, code)).toEqual(parsed);
          expect(fromDecimalString(`000${value}`, code)).toEqual(parsed);
          // And rendering what was parsed parses back to the same thing, so the
          // canonical form is a fixed point rather than a third representation.
          expect(fromDecimalString(toDecimalString(parsed), code)).toEqual(parsed);
        },
      ),
    );
  });

  it("either returns a valid Money or throws InvalidMoneyError — never anything else", () => {
    // Totality. These functions sit at the edge of the payments domain and are
    // reached by provider responses and request bodies, so the failure mode
    // that matters is an unhandled `TypeError` from inside a pure function
    // rather than the domain error the callers catch.
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noDefaultInfinity: false, noNaN: false }), amountMinor),
        fc.oneof(fc.string(), fc.mixedCase(currency)),
        (amount, code) => {
          const outcome = outcomeOf(() => normaliseMoney({ amountMinor: amount, currency: code }));

          if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(InvalidMoneyError);
            return;
          }
          expect(Number.isSafeInteger(outcome.value.amountMinor)).toBe(true);
          expect(outcome.value.amountMinor).toBeGreaterThanOrEqual(0);
          expect(outcome.value.currency).toMatch(/^[A-Z]{3}$/);
        },
      ),
    );
  });

  it("parses or refuses any string, and what it parses renders back", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          // Numeric-shaped noise, so the generator spends its budget on strings
          // that reach the arithmetic rather than on ones the regex rejects.
          fc.stringMatching(/^[ \t]{0,2}[0-9]{1,24}(\.[0-9]{0,4})?[ \t]{0,2}$/),
          // And amounts that are well-formed but too large to hold, which is
          // the second bug: `Number("9999999999999999999999")` is 1e22, and a
          // length-biased generator reaches 16+ digits too rarely to rely on.
          fc
            .tuple(
              fc.array(fc.constantFrom(..."0123456789".split("")), {
                minLength: 16,
                maxLength: 24,
              }),
              fc.constantFrom("", ".0", ".99"),
            )
            .map(([digits, fraction]) => `${digits.join("")}${fraction}`),
        ),
        fc.oneof(fc.string(), fc.mixedCase(currency)),
        (value, code) => {
          const outcome = outcomeOf(() => fromDecimalString(value, code));

          if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(InvalidMoneyError);
            return;
          }
          expect(Number.isSafeInteger(outcome.value.amountMinor)).toBe(true);
          expect(outcome.value.amountMinor).toBeGreaterThanOrEqual(0);
          expect(fromDecimalString(toDecimalString(outcome.value), code)).toEqual(outcome.value);
        },
      ),
    );
  });

  it("treats exactly the documented zero-decimal set as zero-decimal", () => {
    // Over every three-letter code rather than over a sample: this is what
    // would have caught `"TWD"` being deleted from the set, which mutation
    // testing had to find instead because the example suite named two of the
    // three.
    fc.assert(
      fc.property(fc.mixedCase(fc.stringMatching(/^[A-Z]{3}$/)), (code) => {
        const expected = ZERO_DECIMAL.includes(code.toUpperCase() as (typeof ZERO_DECIMAL)[number])
          ? 0
          : 2;

        expect(minorUnitExponent(code)).toBe(expected);
      }),
    );
  });

  it("compares currencies case-insensitively, reflexively and symmetrically", () => {
    fc.assert(
      fc.property(money, fc.mixedCase(currency), currency, (value, sameCode, otherCode) => {
        const self = { ...value, currency: sameCode };

        expect(sameCurrency(value, value)).toBe(true);
        expect(sameCurrency(value, { ...self, currency: value.currency.toLowerCase() })).toBe(true);
        expect(sameCurrency(value, { amountMinor: 1, currency: otherCode })).toBe(
          sameCurrency({ amountMinor: 1, currency: otherCode }, value),
        );
        expect(sameCurrency(value, { amountMinor: 1, currency: otherCode })).toBe(
          value.currency.toUpperCase() === otherCode.toUpperCase(),
        );
      }),
    );
  });
});
