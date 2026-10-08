import { BadRequestException } from "@nestjs/common";
import type { ReservedLine } from "./ports";

/**
 * The most of any one product a single order may be for.
 *
 * A bound per **SKU** rather than per line, which is the distinction this
 * module exists to make. `CreateOrderItemDto` bounds a line, and a validator
 * cannot do better: `@Max` sees one element at a time and has no way to notice
 * that the element beside it names the same product. Twenty lines of a hundred
 * is twenty valid lines, and the order it adds up to is for two thousand.
 */
export const MAX_QUANTITY_PER_SKU = 100;

/**
 * A basket asking for more of something than an order may be for.
 *
 * A `BadRequestException` like {@link import("./catalogue").UnknownSkuError},
 * and for the same reason: this is reached on the request path, from input the
 * caller chose, so it is a 400 with the offending SKU in it rather than a saga
 * that fails three steps later against a shelf.
 */
export class LineQuantityExceededError extends BadRequestException {
  constructor(
    readonly sku: string,
    readonly quantity: number,
  ) {
    super(
      `Order is for ${quantity} of "${sku}", more than the ${MAX_QUANTITY_PER_SKU} ` +
        "allowed per SKU",
    );
  }
}

/**
 * Sums repeated SKUs, so two lines of the same product are one line.
 *
 * Nothing is dropped and nothing is capped — the total quantity of every SKU
 * is the same coming out as going in. That makes it safe for an adapter to
 * apply to input it did not validate, which is what
 * `InMemoryInventoryService.reserve` does.
 *
 * Order is first appearance, so the basket a customer sees back is in the order
 * they built it. Sorting would be just as canonical and would reorder every
 * existing order's lines for no reason anybody asked for.
 *
 * Generic over anything that *is* a line, so the same merge serves a
 * `ReservedLine` on its way to the warehouse and a priced `OrderItem` on its
 * way to the order row. Whatever else the line carries is taken from its first
 * appearance: for an `OrderItem` that is `unitPriceMinor`, which is the same on
 * every line of one SKU because it was looked up from the catalogue rather than
 * sent by the caller — see `priceOrder`.
 */
export function mergeLines<T extends ReservedLine>(lines: readonly T[]): readonly T[] {
  const merged = new Map<string, T>();
  for (const line of lines) {
    const seen = merged.get(line.sku);
    // A `Map` iterates in insertion order, which is where first appearance
    // comes from — not from anything this loop does deliberately, so it is
    // pinned by a spec rather than left as a property of the collection
    // somebody might swap. Copied rather than mutated: these lines came from a
    // caller who is entitled to still own them afterwards.
    merged.set(line.sku, seen ? { ...seen, quantity: seen.quantity + line.quantity } : { ...line });
  }
  return [...merged.values()];
}

/**
 * The basket as the domain will store, price, reserve and ship it.
 *
 * {@link mergeLines}, plus the per-SKU bound that only becomes checkable once
 * the lines have been merged.
 *
 * @throws LineQuantityExceededError when any one SKU totals more than
 * {@link MAX_QUANTITY_PER_SKU}.
 */
export function canonicaliseBasket<T extends ReservedLine>(lines: readonly T[]): readonly T[] {
  const basket = mergeLines(lines);
  for (const line of basket) {
    if (line.quantity > MAX_QUANTITY_PER_SKU) {
      throw new LineQuantityExceededError(line.sku, line.quantity);
    }
  }
  return basket;
}
