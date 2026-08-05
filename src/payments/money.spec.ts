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
  });

  describe("minorUnitExponent()", () => {
    it("is 2 for ordinary currencies and 0 for the zero-decimal ones", () => {
      expect(minorUnitExponent("EUR")).toBe(2);
      expect(minorUnitExponent("jpy")).toBe(0);
      expect(minorUnitExponent("HUF")).toBe(0);
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

    it("rejects more precision than the currency allows", () => {
      expect(() => fromDecimalString("1.005", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("1.5", "JPY")).toThrow(InvalidMoneyError);
    });

    it("rejects anything that is not a decimal number", () => {
      expect(() => fromDecimalString("1e3", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("-1.00", "EUR")).toThrow(InvalidMoneyError);
      expect(() => fromDecimalString("", "EUR")).toThrow(InvalidMoneyError);
    });

    it("rejects a malformed currency", () => {
      expect(() => fromDecimalString("1.00", "EURO")).toThrow(InvalidMoneyError);
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
