import { BadRequestException } from "@nestjs/common";
import type { Money } from "@/payments/money";
import { canonicaliseBasket } from "./basket";
import type { OrderItem } from "./order";
import type { ReservedLine } from "./ports";

/**
 * Everything this service will sell, and what it costs.
 *
 * A constant, because a product catalogue is a service of its own in any real
 * deployment and standing one up here would teach nothing about sagas. What it
 * is *not* is a placeholder for taking a price from the client: an order's total
 * is computed here, from a source the buyer cannot write to, because a request
 * that carries its own prices is a request that can name them.
 *
 * One currency for the whole catalogue, so an order can never mix two. Multiple
 * currencies mean a price per currency per SKU and a decision about which one a
 * given buyer sees — a real feature, and not this one.
 */
export const CATALOGUE_CURRENCY = "GBP";

export interface CatalogueEntry {
  readonly name: string;
  /** Integer minor units of {@link CATALOGUE_CURRENCY}. */
  readonly unitPriceMinor: number;
}

export const PRODUCT_CATALOGUE: Readonly<Record<string, CatalogueEntry>> = {
  "SKU-DESK-01": { name: "Standing desk", unitPriceMinor: 34_900 },
  "SKU-CHAIR-02": { name: "Task chair", unitPriceMinor: 18_500 },
  "SKU-LAMP-03": { name: "Desk lamp", unitPriceMinor: 4_250 },
  "SKU-SOLD-OUT": { name: "Sold-out sample", unitPriceMinor: 999 },
};

/** A SKU nobody sells. Caller input, so a 400 rather than a saga failure. */
export class UnknownSkuError extends BadRequestException {
  constructor(sku: string) {
    super(`Unknown SKU "${sku}"`);
  }
}

/** What an order is worth, priced from the catalogue rather than from the request. */
export interface PricedOrder {
  readonly items: readonly OrderItem[];
  readonly total: Money;
}

/**
 * Prices a basket, after reducing it to one line per product.
 *
 * Existence is checked first, over the lines as the caller sent them, so a SKU
 * nobody sells is reported as such even when the same line is also over the
 * per-SKU bound — and the SKU named is the first one the caller got wrong
 * rather than the first one left after a merge reordered them.
 */
export function priceOrder(lines: readonly ReservedLine[]): PricedOrder {
  // Priced in the order the caller sent, which is what makes `UnknownSkuError`
  // name the first SKU they got wrong, and what puts it ahead of the per-SKU
  // bound: a line that is both unknown and over the bound is answered as
  // unknown, the more useful of the two.
  const priced = lines.map((line) => {
    const entry = PRODUCT_CATALOGUE[line.sku];
    if (!entry) throw new UnknownSkuError(line.sku);
    return { sku: line.sku, quantity: line.quantity, unitPriceMinor: entry.unitPriceMinor };
  });

  // Merged after pricing rather than before it, so the catalogue is read once
  // per line and no line is looked up for a second time to recover a price the
  // merge dropped.
  const items = canonicaliseBasket(priced);
  const amountMinor = items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
  return { items, total: { amountMinor, currency: CATALOGUE_CURRENCY } };
}
