/** DI token for {@link InventoryService}. */
export const INVENTORY_SERVICE = Symbol("INVENTORY_SERVICE");

/**
 * One line of a reservation.
 *
 * A type alias rather than an interface, and that is load-bearing: lines travel
 * in the checkout saga's state, which is `jsonb`, and only a type alias gets the
 * implicit index signature that makes it assignable to `SagaState`. See
 * `src/saga/saga-state.ts`.
 */
export type ReservedLine = {
  readonly sku: string;
  readonly quantity: number;
};

/** Stock held for one order until it ships or the hold is released. */
export interface StockReservation {
  readonly id: string;
  readonly orderId: string;
  readonly lines: readonly ReservedLine[];
  /** False once {@link InventoryService.release} has been honoured. */
  readonly held: boolean;
}

export interface ReserveStockInput {
  readonly orderId: string;
  readonly lines: readonly ReservedLine[];
  /**
   * The reservation's id, chosen by the **caller**.
   *
   * This is the saga step's idempotency key, and making it the id rather than a
   * separate header is what closes the gap a compensation would otherwise fall
   * into. A reserve whose response was lost leaves a hold the caller has no id
   * for, so a server-assigned id makes "release whatever I reserved" a request
   * the client cannot express — the stock stays committed to an order that was
   * cancelled, and nothing in the system knows. Naming it up front means the
   * compensation can always address the hold, whether or not it ever heard that
   * it was taken. It is `PUT` semantics rather than `POST`, for exactly the same
   * reason.
   */
  readonly reservationId: string;
}

/**
 * The warehouse, as the checkout saga sees one.
 *
 * A port rather than a class for the same reason `PaymentProvider` is: in a
 * deployment this is another service over HTTP, and the saga must not be
 * written against whichever one it happens to be. What ships is an in-process
 * implementation — see `InMemoryInventoryService`, which is a working warehouse
 * rather than a stub, for the reason `MockPaymentProvider` is a working gateway.
 */
export interface InventoryService {
  /**
   * Holds stock for an order.
   *
   * Rejects with {@link import("../orders.errors").OutOfStockError} when the
   * quantity is not available. That is a *business* answer rather than a
   * transient failure, and the saga treats it as such: retrying a checkout
   * against an empty shelf six more times only delays telling the customer.
   *
   * All lines or none. A partial hold is unaddressable — the caller is about
   * to be told it failed, so nothing will ever release the part that succeeded.
   */
  reserve(input: ReserveStockInput): Promise<StockReservation>;

  /**
   * Returns held stock to the shelf.
   *
   * Idempotent, and silent about a reservation it does not recognise. It is a
   * compensation, so it runs for a `reserve` that failed as well as for one
   * that succeeded — and "the reservation was never made" is exactly the state
   * it is trying to reach.
   */
  release(reservationId: string): Promise<void>;

  /** Resolves `null` — never `undefined` — for an unknown id. */
  find(reservationId: string): Promise<StockReservation | null>;
}
