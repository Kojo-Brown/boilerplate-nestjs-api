import { normaliseMoney } from "@/payments/money";
import { LineQuantityExceededError, MAX_QUANTITY_PER_SKU } from "./basket";
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

  it("prices a repeated SKU as one line of the summed quantity", () => {
    // A basket is a set of products with quantities, not a list of clicks. Two
    // lines of the same SKU reaching the order row means the API answers with
    // one product twice, `order.placed` reports a `lineCount` of 2 for a
    // one-product order, and the hold the warehouse takes — which *is* merged —
    // describes a basket the order row does not.
    const priced = priceOrder([
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-DESK-01", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ]);

    expect(priced.items).toEqual([
      { sku: "SKU-LAMP-03", quantity: 3, unitPriceMinor: 4_250 },
      { sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 },
    ]);
  });

  it("charges the same for a basket however it was built up", () => {
    // Merging regroups the lines; it must not change what anybody pays. This
    // is the assertion that would catch a "merge" that dropped a line.
    const split = priceOrder([
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ]);
    const combined = priceOrder([{ sku: "SKU-LAMP-03", quantity: 3 }]);

    expect(split.total).toEqual(combined.total);
    expect(split.items).toEqual(combined.items);
  });

  it("refuses a basket whose merged quantity passes the per-SKU bound", () => {
    // `CreateOrderItemDto` accepts both lines — each is within `@Max` — so this
    // is the only place the request can be refused.
    expect(() =>
      priceOrder([
        { sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU },
        { sku: "SKU-LAMP-03", quantity: 1 },
      ]),
    ).toThrow(LineQuantityExceededError);
  });

  it("checks the SKU exists before it checks the quantity", () => {
    // Both are 400s, so the order only shows in the message — and "unknown SKU"
    // is the more useful one to lead with when the SKU is also over the bound.
    expect(() =>
      priceOrder([{ sku: "SKU-IMAGINARY", quantity: MAX_QUANTITY_PER_SKU + 1 }]),
    ).toThrow(UnknownSkuError);
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
