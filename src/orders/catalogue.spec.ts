import { normaliseMoney } from "@/payments/money";
import { CATALOGUE_CURRENCY, PRODUCT_CATALOGUE, UnknownSkuError, priceOrder } from "./catalogue";
import { SEED_STOCK } from "./services/in-memory-inventory.service";

describe("priceOrder", () => {
  it("prices from the catalogue rather than from the request", () => {
    const priced = priceOrder([{ sku: "SKU-DESK-01", quantity: 2 }]);

    expect(priced.items).toEqual([{ sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 }]);
    expect(priced.total).toEqual({ amountMinor: 69_800, currency: CATALOGUE_CURRENCY });
  });

  it("sums every line", () => {
    const priced = priceOrder([
      { sku: "SKU-DESK-01", quantity: 1 },
      { sku: "SKU-CHAIR-02", quantity: 2 },
      { sku: "SKU-LAMP-03", quantity: 3 },
    ]);

    expect(priced.total.amountMinor).toBe(34_900 + 2 * 18_500 + 3 * 4_250);
  });

  it("refuses a SKU nobody sells, as caller input rather than as a saga failure", () => {
    expect(() => priceOrder([{ sku: "SKU-IMAGINARY", quantity: 1 }])).toThrow(UnknownSkuError);
    expect(() => priceOrder([{ sku: "SKU-IMAGINARY", quantity: 1 }])).toThrow(
      /Unknown SKU "SKU-IMAGINARY"/,
    );
  });

  it("produces a total the payments domain accepts", () => {
    // The total goes straight to `PaymentProvider.authorize`, which normalises
    // it: an integer amount in a real currency code. A catalogue entry with a
    // fractional price would fail here rather than at the gateway.
    const priced = priceOrder(Object.keys(PRODUCT_CATALOGUE).map((sku) => ({ sku, quantity: 1 })));
    expect(() => normaliseMoney(priced.total)).not.toThrow();
  });
});

describe("the catalogue and the warehouse", () => {
  it("prices everything the warehouse stocks", () => {
    // A SKU on a shelf with no price is an order that cannot be placed for
    // stock that is being held for nobody.
    expect(Object.keys(SEED_STOCK).sort()).toEqual(Object.keys(PRODUCT_CATALOGUE).sort());
  });
});
