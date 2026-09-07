import type { Money } from "@/payments/money";

/** Where an order is in its life. Mirrors the `OrderStatus` enum in the schema. */
export type OrderStatus = "PENDING" | "PROCESSING" | "CONFIRMED" | "CANCELLED";

/**
 * One line of an order, as agreed at the time it was placed.
 *
 * The price is on the line rather than looked up from a catalogue, because an
 * order is a record of an agreement: a price that changes next Tuesday must not
 * rewrite what a customer was charged last Monday.
 */
export interface OrderItem {
  readonly sku: string;
  readonly quantity: number;
  /** Integer minor units, in the order's currency. */
  readonly unitPriceMinor: number;
}

/** An order about to be written, as the caller describes it. */
export interface NewOrder {
  readonly id: string;
  readonly userId: string;
  readonly items: readonly OrderItem[];
  readonly total: Money;
  readonly shippingCountry: string;
  /** The saga that will drive it. Written in the same transaction as the row. */
  readonly sagaId: string;
}

/** One persisted order. */
export interface OrderRecord {
  readonly id: string;
  readonly userId: string;
  readonly items: readonly OrderItem[];
  readonly total: Money;
  readonly shippingCountry: string;
  readonly status: OrderStatus;
  readonly failureReason: string | null;
  readonly sagaId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
