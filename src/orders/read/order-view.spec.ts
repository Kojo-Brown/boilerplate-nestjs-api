import { SagaRegistry, defineSaga } from "@/saga";
import type { SagaInstanceRecord, SagaState, SagaStatus } from "@/saga";
import { CHECKOUT_SAGA } from "../checkout.saga";
import type { OrderRecord } from "../order";
import { toOrderView } from "./order-view";

const STEPS = ["accept-order", "reserve-stock", "charge-payment"] as const;

function registry(): SagaRegistry {
  const instance = new SagaRegistry();
  instance.register(
    defineSaga<SagaState>(
      CHECKOUT_SAGA,
      STEPS.map((name) => ({
        name,
        kind: "compensatable" as const,
        execute: async () => undefined,
        compensate: async () => undefined,
      })),
    ),
  );
  return instance;
}

const order: OrderRecord = {
  id: "order-1",
  userId: "user-1",
  items: [{ sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 }],
  total: { amountMinor: 34_900, currency: "GBP" },
  shippingCountry: "GB",
  status: "PROCESSING",
  failureReason: null,
  sagaId: "saga-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function instance(overrides: Partial<SagaInstanceRecord> = {}): SagaInstanceRecord {
  return {
    id: "saga-1",
    name: CHECKOUT_SAGA,
    status: "RUNNING",
    cursor: 2,
    attempts: 0,
    nextAttemptAt: new Date(),
    state: { reservationId: "saga-1:reserve-stock", paymentId: null, shipmentId: null },
    log: [],
    lastError: null,
    correlationId: null,
    lockedBy: null,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("toOrderView", () => {
  it("names the step the saga is at, resolved through the definition", () => {
    // The row stores a position; only the definition turns 2 into a name.
    const view = toOrderView(order, instance(), registry());

    expect(view.fulfilment.status).toBe("RUNNING");
    expect(view.fulfilment.step).toBe("charge-payment");
  });

  it("carries the ids the saga has learned so far", () => {
    const view = toOrderView(order, instance(), registry());

    expect(view.fulfilment.reservationId).toBe("saga-1:reserve-stock");
    expect(view.fulfilment.paymentId).toBeNull();
    expect(view.fulfilment.shipmentId).toBeNull();
  });

  it("names the step a stuck saga stopped at, which is the one worth reporting", () => {
    const view = toOrderView(order, instance({ status: "STUCK", cursor: 1 }), registry());

    expect(view.fulfilment.step).toBe("reserve-stock");
  });

  it.each<SagaStatus>(["COMPLETED", "COMPENSATED"])(
    "names no step for a %s saga, which is not at one",
    (status) => {
      const view = toOrderView(order, instance({ status, cursor: 3 }), registry());
      expect(view.fulfilment.step).toBeNull();
    },
  );

  it("reports nothing rather than guessing when the instance is gone", () => {
    // A retention job, or a manual cleanup. The order is still the customer's
    // record of what happened and must still be readable.
    const view = toOrderView(order, null, registry());

    expect(view.fulfilment).toEqual({
      // Still the id the order was written with: it is what a support
      // conversation is about, whether or not the row is still there.
      sagaId: order.sagaId,
      status: null,
      step: null,
      reservationId: null,
      paymentId: null,
      shipmentId: null,
    });
  });

  it("reports no step for an instance whose definition this build no longer has", () => {
    const view = toOrderView(order, instance({ name: "order.retired" }), new SagaRegistry());

    expect(view.fulfilment.status).toBe("RUNNING");
    // An index nobody can interpret is worse than saying nothing.
    expect(view.fulfilment.step).toBeNull();
  });
});
