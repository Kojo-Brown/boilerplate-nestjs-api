import { Injectable } from "@nestjs/common";
import { OutOfStockError } from "../orders.errors";
import type { InventoryService, ReserveStockInput, ReservedLine, StockReservation } from "../ports";

/**
 * What is on the shelves when the process starts.
 *
 * Obviously synthetic SKUs, for the reason `REFERENCE_PAYLOADS` uses obviously
 * synthetic addresses: a fixture that looks like real data is one somebody
 * eventually treats as real data. `SKU-SOLD-OUT` exists so that the
 * out-of-stock path can be exercised from a request rather than only from a
 * unit test with a double.
 */
export const SEED_STOCK: Readonly<Record<string, number>> = {
  "SKU-DESK-01": 25,
  "SKU-CHAIR-02": 40,
  "SKU-LAMP-03": 12,
  "SKU-SOLD-OUT": 0,
};

/**
 * An in-process warehouse.
 *
 * Not a stub: it holds stock, refuses what it does not have, and returns the
 * same reservation for a repeated id — so a saga that reserves twice, or that
 * releases a hold it never took, fails here rather than in staging against a
 * warehouse API. That is the same argument `MockPaymentProvider` makes for
 * running the real state machine rather than resolving with whatever it is
 * handed.
 *
 * State is on the instance, so it is bounded by the process and lost on
 * restart. In a deployment this port is an HTTP client onto somebody else's
 * service and nothing in `checkout.saga.ts` changes when it is.
 */
@Injectable()
export class InMemoryInventoryService implements InventoryService {
  private readonly stock = new Map<string, number>(Object.entries(SEED_STOCK));
  private readonly reservations = new Map<string, StockReservation>();

  async reserve(input: ReserveStockInput): Promise<StockReservation> {
    // The caller names the reservation, so this is idempotent by construction:
    // a retry after a lost response finds the hold it already made instead of
    // taking a second one. See the note on `ReserveStockInput.reservationId`.
    const existing = this.reservations.get(input.reservationId);
    if (existing) return existing;

    // Merged first, so two lines of the same SKU are one quantity. Checking
    // them separately would compare each against the *whole* shelf and pass a
    // request for twice what is there, which is the shape of an oversell that
    // no individual line looks wrong in.
    const lines = mergeLines(input.lines);

    // Checked in full before anything is decremented. A partial reservation —
    // two lines held, the third refused — would leave stock committed to an
    // order that is about to be told it cannot have it, and nothing would ever
    // release it, because the caller has no id for the hold that half-happened.
    for (const line of lines) {
      const available = this.stock.get(line.sku) ?? 0;
      if (available < line.quantity) {
        throw new OutOfStockError(line.sku, line.quantity, available);
      }
    }

    for (const line of lines) {
      this.stock.set(line.sku, (this.stock.get(line.sku) ?? 0) - line.quantity);
    }

    const reservation: StockReservation = {
      id: input.reservationId,
      orderId: input.orderId,
      lines,
      held: true,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  async release(reservationId: string): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    // Silent for an unknown id and for one already released: this is a
    // compensation, and both of those *are* the state it is trying to reach.
    // Throwing would turn "there was nothing to undo" into a retry ladder and
    // then into a stuck saga.
    if (!reservation || !reservation.held) return;

    for (const line of reservation.lines) {
      this.stock.set(line.sku, (this.stock.get(line.sku) ?? 0) + line.quantity);
    }
    this.reservations.set(reservationId, { ...reservation, held: false });
  }

  async find(reservationId: string): Promise<StockReservation | null> {
    return this.reservations.get(reservationId) ?? null;
  }

  /** What is on the shelf. For the specs, and for a local sanity check. */
  stockOf(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  /** Puts stock on a shelf. For the specs, and for seeding a development run. */
  setStock(sku: string, quantity: number): void {
    this.stock.set(sku, quantity);
  }

  /**
   * Puts the shelves back as they were and forgets every hold.
   *
   * For a suite that shares one application across its specs: without it the
   * stock left by one checkout is the stock the next one starts from, and an
   * assertion about a released hold passes or fails depending on which spec ran
   * first.
   */
  reset(): void {
    this.stock.clear();
    for (const [sku, quantity] of Object.entries(SEED_STOCK)) this.stock.set(sku, quantity);
    this.reservations.clear();
  }

  /** Every hold this warehouse is aware of, released or not. */
  get held(): readonly StockReservation[] {
    return [...this.reservations.values()];
  }
}

/** Sums duplicate SKUs, so two lines of the same item are one hold. */
export function mergeLines(lines: readonly ReservedLine[]): readonly ReservedLine[] {
  const merged = new Map<string, number>();
  for (const line of lines) {
    merged.set(line.sku, (merged.get(line.sku) ?? 0) + line.quantity);
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}
