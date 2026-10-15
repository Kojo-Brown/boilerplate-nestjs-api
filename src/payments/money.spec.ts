import {
  InvalidMoneyError,
  fromDecimalString,
  minorUnitExponent,
  normaliseMoney,
  sameCurrency,
  toDecimalString,
} from "./money";

describe("money", () => {
  describe("normaliseMoney()", () => {
    it("upper-cases the currency", () => {
      expect(normaliseMoney({ amountMinor: 100, currency: "eur" })).toEqual({
        amountMinor: 100,
        currency: "EUR",
      });
    });

    it("rejects a currency that is not three letters", () => {
      expect(() => normaliseMoney({ amountMinor: 100, currency: "EURO" })).toThrow(
        InvalidMoneyError,
      );
      expect(() => normaliseMoney({ amountMinor: 100, currency: "E1R" })).toThrow(
        InvalidMoneyError,
      );
    });

    it("rejects a fractional amount — minor units are integers", () => {
      expect(() => normaliseMoney({ amountMinor: 10.5, currency: "EUR" })).toThrow(
        InvalidMoneyError,
      );
    });

    it("rejects a negative amount", () => {
      expect(() => normaliseMoney({ amountMinor: -1, currency: "EUR" })).toThrow(InvalidMoneyError);
    });

    // `Number.isInteger(1e21)` is true, so this amount used to pass every
    // check and come out of `toDecimalString` as "1e+.21" — `String(1e21)` is
    // "1e+21" and the padding/slicing treats it as digits. Found by the
    // round-trip property in `money.property.spec.ts`, which shrank to exactly
    // this value.
    it("rejects an amount too large to be represented exactly", () => {
      expect(() => normaliseMoney({ amountMinor: 1e21, currency: "EUR" })).toThrow(
        InvalidMoneyError,
      );
      expect(() =>
        normaliseMoney({ amountMinor: Number.MAX_SAFE_INTEGER + 2, currency: "EUR" }),
      ).toThrow(InvalidMoneyError);
    });

    it("accepts the largest exactly representable amount", () => {
      // The boundary is inclusive: 2^53 - 1 minor units is a real amount and
      // renders without loss. Asserted so that a mutant tightening the guard
      // to `<` has something to fail.
      expect(normaliseMoney({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "EUR" })).toEqual({
        amountMinor: Number.MAX_SAFE_INTEGER,
        currency: "EUR",
      });
    });

    // The reason this function exists is to fail *locally*, with a message, so
    // that a malformed amount is not an opaque 400 from Stripe three hops
    // later — which makes the message part of the contract rather than
    // decoration. Each one is asserted to name the value it refused: the type
    // alone tells an on-call engineer which of three checks fired but not what
    // was in the request. Mutation testing is what found these unasserted; the
    // suite was green with every message replaced by "".
    it("says what it refused and why", () => {
      expect(() => normaliseMoney({ amountMinor: 100, currency: "EURO" })).toThrow(
        /3-letter ISO 4217 code, received "EURO"/,
      );
      expect(() => normaliseMoney({ amountMinor: 10.5, currency: "EUR" })).toThrow(
        /integer number of minor units, received 10\.5/,
      );
      expect(() => normaliseMoney({ amountMinor: -1, currency: "EUR" })).toThrow(
        /must not be negative, received -1/,
      );
      expect(() => normaliseMoney({ amountMinor: 1e21, currency: "EUR" })).toThrow(
        /Amount 1e\+21 is larger than the largest minor-unit amount that can be represented exactly \(9007199254740991\)/,
      );
    });
  });

  describe("InvalidMoneyError", () => {
    it("carries its own name", () => {
      // Set in the constructor rather than inherited, because `Error`'s own
      // `name` is "Error" and that is what a structured log line, a serialised
      // response body and a Sentry group key would otherwise show for every
      // error this module throws.
      expect(new InvalidMoneyError("whatever").name).toBe("InvalidMoneyError");
    });
  });

  describe("minorUnitExponent()", () => {
    it("is 2 for ordinary currencies and 0 for the zero-decimal ones", () => {
      expect(minorUnitExponent("EUR")).toBe(2);
      expect(minorUnitExponent("jpy")).toBe(0);
      expect(minorUnitExponent("HUF")).toBe(0);
      // The whole zero-decimal set, not a sample of it: "TWD" sat in
      // `ZERO_DECIMAL_CURRENCIES` unasserted, so deleting it changed nothing
      // the suite could see and `1000 TWD` would have gone to PayPal as
      // "10.00" — a hundredth of the amount, accepted without complaint.
      expect(minorUnitExponent("TWD")).toBe(0);
    });
  });

  describe("toDecimalString()", () => {
    it("renders two decimal places for ordinary currencies", () => {
      expect(toDecimalString({ amountMinor: 2350, currency: "EUR" })).toBe("23.50");
      expect(toDecimalString({ amountMinor: 5, currency: "USD" })).toBe("0.05");
      expect(toDecimalString({ amountMinor: 0, currency: "GBP" })).toBe("0.00");
    });

    it("renders zero-decimal currencies without a fraction", () => {
      // PayPal rejects "2350.00" for JPY outright.
      expect(toDecimalString({ amountMinor: 2350, currency: "JPY" })).toBe("2350");
    });

    it("does not lose precision on values a float would round", () => {
      expect(toDecimalString({ amountMinor: 100_000_001, currency: "EUR" })).toBe("1000000.01");
    });
  });

  describe("fromDecimalString()", () => {
    it("round-trips through toDecimalString", () => {
      for (const amountMinor of [0, 1, 99, 100, 2350, 100_000_001]) {
        const money = { amountMinor, currency: "EUR" };
        expect(fromDecimalString(toDecimalString(money), "EUR")).toEqual(money);
      }
    });

    it("accepts a value with no fractional part", () => {
      expect(fromDecimalString("23", "EUR")).toEqual({ amountMinor: 2300, currency: "EUR" });
    });

    it("reads zero-decimal currencies as whole units", () => {
      expect(fromDecimalString("2350", "JPY")).toEqual({ amountMinor: 2350, currency: "JPY" });
    });

    it("tolerates surrounding whitespace", () => {
      // Deliberate: the input is a provider's JSON string field, and a
      // `" 23.50"` is a formatting difference rather than a malformed amount.
      // The `.trim()` was unasserted, so removing it left the suite green while
      // turning every padded value into "not a decimal number".
      expect(fromDecimalString(" 23.50 ", "EUR")).toEqual({
        amountMinor: 2350,
        currency: "EUR",
      });
      expect(fromDecimalString("\n2350\t", "JPY")).toEqual({
        amountMinor: 2350,
        currency: "JPY",
      });
    });

    it("rejects more precision than the currency allows", () => {
      expect(() => fromDecimalString("1.005", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("1.5", "JPY")).toThrow(InvalidMoneyError);
    });

    it("rejects an amount too large to be represented exactly", () => {
      // `Number("9999999999999999999999")` is 1e22 — not the value the
      // provider sent, and not anything that renders back to it. Rounding a
      // payment amount silently is the one outcome this module exists to
      // prevent, so it is refused rather than parsed.
      expect(() => fromDecimalString("99999999999999999999.99", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("99999999999999999999.99", "EUR")).toThrow(
        /Amount "99999999999999999999\.99" is larger than the largest minor-unit amount that can be represented exactly \(9007199254740991 minor units\)/,
      );
    });

    it("accepts the largest exactly representable amount", () => {
      expect(fromDecimalString("90071992547409.91", "EUR")).toEqual({
        amountMinor: Number.MAX_SAFE_INTEGER,
        currency: "EUR",
      });
    });

    it("rejects anything that is not a decimal number", () => {
      expect(() => fromDecimalString("1e3", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("-1.00", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("", "EUR")).toThrow(InvalidMoneyError);
    });

    it("rejects a malformed currency", () => {
      expect(() => fromDecimalString("1.00", "EURO")).toThrow(InvalidMoneyError);
    });

    it("says what it refused and why", () => {
      // As in `normaliseMoney`: the value, and which rule it broke. The
      // precision message carries the currency and its exponent because
      // "1.005" is a perfectly good EUR amount in every respect except the one
      // that matters, and a bare "invalid amount" sends the reader to the wrong
      // place.
      expect(() => fromDecimalString("1e3", "EUR")).toThrow(/Amount "1e3" is not a decimal number/);
      expect(() => fromDecimalString("1.005", "EUR")).toThrow(
        /Amount "1\.005" has more precision than EUR allows \(2 dp\)/,
      );
      expect(() => fromDecimalString("1.00", "EURO")).toThrow(
        /3-letter ISO 4217 code, received "EURO"/,
      );
    });
  });

  describe("sameCurrency()", () => {
    it("compares case-insensitively", () => {
      expect(
        sameCurrency({ amountMinor: 1, currency: "eur" }, { amountMinor: 2, currency: "EUR" }),
      ).toBe(true);
      expect(
        sameCurrency({ amountMinor: 1, currency: "EUR" }, { amountMinor: 1, currency: "USD" }),
      ).toBe(false);
    });
  });
});
