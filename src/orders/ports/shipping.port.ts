import type { ReservedLine } from "./inventory.port";

/** DI token for {@link ShippingService}. */
export const SHIPPING_SERVICE = Symbol("SHIPPING_SERVICE");

/** A parcel handed to a carrier. */
export interface Shipment {
  readonly id: string;
  readonly orderId: string;
  readonly carrier: string;
  readonly trackingCode: string;
  /** ISO-3166 alpha-2, upper case. */
  readonly destination: string;
}

export interface CreateShipmentInput {
  readonly orderId: string;
  /** ISO-3166 alpha-2. */
  readonly destination: string;
  readonly lines: readonly ReservedLine[];
  /**
   * The shipment's id, chosen by the caller — the saga step's idempotency key.
   *
   * Caller-assigned for the reason `ReserveStockInput.reservationId` is, and
   * with more at stake: this is the pivot, so a booking whose response was lost
   * and that was then booked again is two parcels, one of which nobody will
   * ever be paid for.
   */
  readonly shipmentId: string;
}

/**
 * The carrier integration, as the checkout saga sees one.
 *
 * This is the saga's **pivot**, and the interface says why by what it does not
 * have: there is no `cancelShipment`. Once a parcel is in the carrier's
 * network the order cannot be unmade — a return is a new process with its own
 * cost, not the inverse of a dispatch — so the step that calls this is the
 * point past which the saga may only go forward.
 */
export interface ShippingService {
  /**
   * Books a parcel.
   *
   * Rejects with {@link import("../orders.errors").UnservicedDestinationError}
   * for a country no carrier covers, which is permanent and turns the saga
   * around, and with an ordinary error for a carrier that is merely
   * unreachable, which is transient and is retried.
   */
  createShipment(input: CreateShipmentInput): Promise<Shipment>;

  /** Resolves `null` — never `undefined` — for an unknown id. */
  find(shipmentId: string): Promise<Shipment | null>;
}
