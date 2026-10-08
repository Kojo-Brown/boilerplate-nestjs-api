import { BadRequestException } from "@nestjs/common";
import type { ReservedLine } from "./ports";
import {
  LineQuantityExceededError,
  MAX_QUANTITY_PER_SKU,
  canonicaliseBasket,
  mergeLines,
} from "./basket";

const totalQuantity = (lines: readonly ReservedLine[]): number =>
  lines.reduce((sum, line) => sum + line.quantity, 0);

describe("mergeLines", () => {
  it("leaves a basket with no repeats exactly as it is", () => {
    const lines: readonly ReservedLine[] = [
      { sku: "SKU-DESK-01", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ];

    expect(mergeLines(lines)).toEqual(lines);
  });

  it("sums two lines of the same SKU into one", () => {
    expect(
      mergeLines([
        { sku: "SKU-LAMP-03", quantity: 1 },
        { sku: "SKU-LAMP-03", quantity: 2 },
      ]),
    ).toEqual([{ sku: "SKU-LAMP-03", quantity: 3 }]);
  });

  it("keeps the order the customer built the basket in", () => {
    // First appearance, not sorted: the line the repeat merges into is the one
    // that was there first, and the lines around it do not move.
    expect(
      mergeLines([
        { sku: "SKU-LAMP-03", quantity: 1 },
        { sku: "SKU-DESK-01", quantity: 1 },
        { sku: "SKU-LAMP-03", quantity: 4 },
      ]),
    ).toEqual([
      { sku: "SKU-LAMP-03", quantity: 5 },
      { sku: "SKU-DESK-01", quantity: 1 },
    ]);
  });

  it("changes nothing on a basket it has already merged", () => {
    // Idempotence is what lets an adapter merge defensively without caring
    // whether the caller did. `InMemoryInventoryService` relies on it.
    const once = mergeLines([
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ]);

    expect(mergeLines(once)).toEqual(once);
  });

  it("conserves the quantity of every SKU", () => {
    const lines: readonly ReservedLine[] = [
      { sku: "SKU-DESK-01", quantity: 3 },
      { sku: "SKU-LAMP-03", quantity: 7 },
      { sku: "SKU-DESK-01", quantity: 5 },
      { sku: "SKU-CHAIR-02", quantity: 1 },
    ];

    const merged = mergeLines(lines);

    // The merge is a regrouping, never a discount: nothing may be lost, and
    // nothing invented.
    expect(totalQuantity(merged)).toBe(totalQuantity(lines));
    expect(merged).toEqual([
      { sku: "SKU-DESK-01", quantity: 8 },
      { sku: "SKU-LAMP-03", quantity: 7 },
      { sku: "SKU-CHAIR-02", quantity: 1 },
    ]);
  });

  it("names every SKU exactly once", () => {
    const skus = mergeLines([
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 1 },
    ]).map((line) => line.sku);

    expect(skus).toEqual([...new Set(skus)]);
  });

  it("merges an empty basket to an empty basket", () => {
    expect(mergeLines([])).toEqual([]);
  });

  it("does not mutate the basket it was given", () => {
    const lines: ReservedLine[] = [
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ];

    mergeLines(lines);

    expect(lines).toEqual([
      { sku: "SKU-LAMP-03", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ]);
  });
});

describe("canonicaliseBasket", () => {
  it("merges repeats, like mergeLines", () => {
    expect(
      canonicaliseBasket([
        { sku: "SKU-LAMP-03", quantity: 1 },
        { sku: "SKU-LAMP-03", quantity: 2 },
      ]),
    ).toEqual([{ sku: "SKU-LAMP-03", quantity: 3 }]);
  });

  it("allows a SKU right up to the bound", () => {
    expect(canonicaliseBasket([{ sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU }])).toEqual([
      { sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU },
    ]);
  });

  it("refuses a SKU one over the bound", () => {
    expect(() =>
      canonicaliseBasket([{ sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU + 1 }]),
    ).toThrow(LineQuantityExceededError);
  });

  it("refuses the bound being defeated by repeating the SKU", () => {
    // The defect this module was written for. Each of these lines is valid on
    // its own and `CreateOrderItemDto` accepts both, because a per-element
    // validator cannot see across elements. Together they are an order for
    // twice what an order may be for.
    const basket: readonly ReservedLine[] = [
      { sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU },
      { sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU },
    ];

    expect(() => canonicaliseBasket(basket)).toThrow(LineQuantityExceededError);
    expect(() => canonicaliseBasket(basket)).toThrow(
      /Order is for 200 of "SKU-LAMP-03", more than the 100 allowed per SKU/,
    );
  });

  it("judges each SKU on its own merged quantity", () => {
    // Two SKUs at the bound is a large order, not an invalid one: the bound is
    // per SKU, and nothing here is a bound on the basket.
    expect(() =>
      canonicaliseBasket([
        { sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU },
        { sku: "SKU-DESK-01", quantity: MAX_QUANTITY_PER_SKU },
      ]),
    ).not.toThrow();
  });

  it("refuses as caller input, so the request path answers 400", () => {
    // Reached from `POST /v1/orders` through `priceOrder`, before anything is
    // written. A plain `Error` here would be a 500 for a request the caller
    // can fix, and `AllExceptionsFilter` would have nothing better to say.
    let thrown: unknown;
    try {
      canonicaliseBasket([{ sku: "SKU-LAMP-03", quantity: MAX_QUANTITY_PER_SKU + 1 }]);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getStatus()).toBe(400);
  });

  it("names the SKU and the quantity it refused", () => {
    const error = new LineQuantityExceededError("SKU-LAMP-03", 200);

    expect(error.sku).toBe("SKU-LAMP-03");
    expect(error.quantity).toBe(200);
  });
});
