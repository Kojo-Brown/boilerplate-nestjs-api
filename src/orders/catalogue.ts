import { BadRequestException } from "@nestjs/common";
import type { Money } from "@/payments/money";
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

export function priceOrder(lines: readonly ReservedLine[]): PricedOrder {
  const items = lines.map((line) => {
    const entry = PRODUCT_CATALOGUE[line.sku];
    if (!entry) throw new UnknownSkuError(line.sku);
    return { sku: line.sku, quantity: line.quantity, unitPriceMinor: entry.unitPriceMinor };
  });

  const amountMinor = items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
  return { items, total: { amountMinor, currency: CATALOGUE_CURRENCY } };
}
