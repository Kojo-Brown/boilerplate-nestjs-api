import { Injectable } from "@nestjs/common";
import { UnservicedDestinationError } from "../orders.errors";
import type { CreateShipmentInput, Shipment, ShippingService } from "../ports";

/**
 * Where the carriers go.
 *
 * A constant rather than a config value, because it is a fact about the
 * imaginary carrier this class stands in for and not a knob an operator should
 * turn. Its real job in this repository is to give the checkout saga a
 * **permanent** failure at the pivot that a request can actually produce —
 * ordering to `AQ` is how `orders.e2e-spec.ts` exercises the compensation path
 * end to end, with a refund and a released hold, rather than by injecting a
 * fault into a double.
 */
export const SERVICED_COUNTRIES: readonly string[] = ["GB", "IE", "FR", "DE", "US", "CA"];

const CARRIERS: readonly string[] = ["parcelforce", "dhl", "ups"];

/**
 * An in-process carrier integration.
 *
 * Idempotent on the caller-assigned shipment id, refuses destinations it does
 * not serve, and hands back a tracking code — enough to run the saga's pivot
 * for real. In a deployment this is somebody's HTTP API and `checkout.saga.ts`
 * does not change.
 */
@Injectable()
export class InMemoryShippingService implements ShippingService {
  private readonly shipments = new Map<string, Shipment>();
  private sequence = 0;

  async createShipment(input: CreateShipmentInput): Promise<Shipment> {
    const existing = this.shipments.get(input.shipmentId);
    if (existing) return existing;

    const destination = input.destination.toUpperCase();
    if (!SERVICED_COUNTRIES.includes(destination)) {
      throw new UnservicedDestinationError(destination);
    }

    this.sequence += 1;
    const shipment: Shipment = {
      id: input.shipmentId,
      orderId: input.orderId,
      // Deterministic rather than random: a spec that asserts on a carrier
      // should not be asserting on a coin flip, and a real integration picks by
      // route and weight rather than by chance either.
      carrier: CARRIERS[this.sequence % CARRIERS.length] ?? "parcelforce",
      trackingCode: `TRK${String(this.sequence).padStart(8, "0")}`,
      destination,
    };
    this.shipments.set(shipment.id, shipment);
    return shipment;
  }

  async find(shipmentId: string): Promise<Shipment | null> {
    return this.shipments.get(shipmentId) ?? null;
  }

  /** Forgets every booking, for a suite that shares one application. */
  reset(): void {
    this.shipments.clear();
    this.sequence = 0;
  }

  /** Every parcel booked. For the specs. */
  get booked(): readonly Shipment[] {
    return [...this.shipments.values()];
  }
}
