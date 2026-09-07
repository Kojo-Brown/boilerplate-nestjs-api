import { randomUUID } from "crypto";
import { TransactionalOutbox } from "@/outbox";
import { MockPaymentProvider } from "@/payments/providers/mock-payment.provider";
import { PaymentProviderFactory } from "@/payments/payment-provider.factory";
import type { PaymentProvider } from "@/payments/ports";
import { SagaOrchestrator, SagaRegistry } from "@/saga";
import type { SagaInstanceRecord } from "@/saga";
import { InMemoryOrderStore } from "@/test-utils/in-memory-order.store";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { realEventContract } from "@/test-utils/event-contract";
import { stubConfig } from "@/test-utils/stub-config";
import { CHECKOUT_SAGA, CheckoutSaga } from "./checkout.saga";
import type { CheckoutSagaState } from "./checkout.saga";
import { priceOrder } from "./catalogue";
import { InMemoryInventoryService } from "./services/in-memory-inventory.service";
import { InMemoryShippingService } from "./services/in-memory-shipping.service";
import type { ReservedLine } from "./ports";

const CONFIG = {
  PAYMENTS_PROVIDER: "mock",
  SAGA_LEASE_MS: 60_000,
  SAGA_STEP_TIMEOUT_MS: 5_000,
  SAGA_BACKOFF_BASE_MS: 1_000,
  SAGA_BACKOFF_MAX_MS: 60_000,
  SAGA_MAX_ATTEMPTS: 2,
};

const USER = "user-1";
const LINES: readonly ReservedLine[] = [{ sku: "SKU-DESK-01", quantity: 2 }];

/**
 * The checkout, wired the way the module wires it, against the participants the
 * module binds.
 *
 * Nothing here is a spy. The saga runs through the real `SagaOrchestrator`, the
 * real `MockPaymentProvider` state machine, the real warehouse and the real
 * carrier — because what these specs are about is what happens *between* those
 * services when one of them says no, and a double that resolved with whatever
 * it was handed would make every one of them pass.
 */
function harness(config: Partial<typeof CONFIG> = {}) {
  const orders = new InMemoryOrderStore();
  const inventory = new InMemoryInventoryService();
  const shipping = new InMemoryShippingService();
  const provider = new MockPaymentProvider();
  const payments = new PaymentProviderFactory(stubConfig({ ...CONFIG, ...config }), [
    provider as PaymentProvider,
  ]);
  const transactions = new InMemoryTransactionRunner();
  const outboxStore = new InMemoryOutboxStore();
  const outbox = new TransactionalOutbox(outboxStore, realEventContract());
  const registry = new SagaRegistry();

  const saga = new CheckoutSaga(
    orders,
    inventory,
    shipping,
    payments,
    transactions,
    outbox,
    registry,
  );
  saga.onModuleInit();

  const sagaStore = new InMemorySagaStore();
  const orchestrator = new SagaOrchestrator(
    sagaStore,
    registry,
    stubConfig({ ...CONFIG, ...config }),
    () => 0.5,
  );

  /** Writes the order and its instance the way `PlaceOrderHandler` does. */
  async function place(
    lines: readonly ReservedLine[] = LINES,
    shippingCountry = "GB",
  ): Promise<{ orderId: string; sagaId: string }> {
    const priced = priceOrder(lines);
    const orderId = randomUUID();

    return transactions.run(async (tx) => {
      const state: CheckoutSagaState = {
        orderId,
        userId: USER,
        currency: priced.total.currency,
        totalMinor: priced.total.amountMinor,
        shippingCountry,
        lines: lines.map((line) => ({ ...line })),
        reservationId: null,
        paymentId: null,
        shipmentId: null,
      };
      const instance = await orchestrator.start(tx, CHECKOUT_SAGA, state);
      await orders.create(tx, {
        id: orderId,
        userId: USER,
        items: priced.items,
        total: priced.total,
        shippingCountry,
        sagaId: instance.id,
      });
      await outbox.stage(tx, "order.placed", {
        orderId,
        userId: USER,
        totalMinor: priced.total.amountMinor,
        currency: priced.total.currency,
        lineCount: priced.items.length,
      });
      return { orderId, sagaId: instance.id };
    });
  }

  const stateOf = (instance: SagaInstanceRecord | null) =>
    (instance?.state ?? {}) as Partial<CheckoutSagaState>;

  return {
    orders,
    inventory,
    shipping,
    provider,
    outboxStore,
    sagaStore,
    orchestrator,
    saga,
    place,
    stateOf,
    steps: () => saga.definition.steps.map((step) => step.name),
  };
}

/** Every event name the outbox has been asked to carry, in order. */
function staged(store: InMemoryOutboxStore): string[] {
  return store.all().map((row) => row.name);
}

describe("CheckoutSaga", () => {
  describe("the definition", () => {
    it("is five steps in the order the money and the goods require", () => {
      expect(harness().steps()).toEqual([
        "accept-order",
        "reserve-stock",
        "charge-payment",
        "create-shipment",
        "confirm-order",
      ]);
    });

    it("puts the pivot at the shipment, with nothing compensatable after it", () => {
      const kinds = harness().saga.definition.steps.map((step) => step.kind);
      expect(kinds).toEqual([
        "compensatable",
        "compensatable",
        "compensatable",
        "pivot",
        "retriable",
      ]);
    });
  });

  describe("a checkout that goes through", () => {
    it("reserves, charges, ships and confirms", async () => {
      const h = harness();
      const { orderId, sagaId } = await h.place();

      const settled = await h.orchestrator.advance(sagaId);

      expect(settled?.status).toBe("COMPLETED");
      expect((await h.orders.find(orderId))?.status).toBe("CONFIRMED");

      const state = h.stateOf(settled);
      expect(state.reservationId).toBe(`${sagaId}:reserve-stock`);
      expect(state.shipmentId).toBe(`${sagaId}:create-shipment`);
      expect(state.paymentId).toMatch(/^pay_mock_/);
    });

    it("takes the stock, captures the money and books the parcel", async () => {
      const h = harness();
      const { sagaId } = await h.place();

      const settled = await h.orchestrator.advance(sagaId);

      expect(h.inventory.stockOf("SKU-DESK-01")).toBe(23);
      expect(h.shipping.booked).toHaveLength(1);

      // The gateway assigns the payment's own id; what the step controls is the
      // `reference`, which is its idempotency key.
      const payment = await h.provider.find(h.stateOf(settled).paymentId ?? "");
      expect(payment?.status).toBe("succeeded");
      expect(payment?.reference).toBe(`${sagaId}:charge-payment`);
    });

    it("announces the order placed and then confirmed, and nothing else", async () => {
      const h = harness();
      const { sagaId } = await h.place();

      await h.orchestrator.advance(sagaId);

      expect(staged(h.outboxStore)).toEqual(["order.placed", "order.confirmed"]);
    });

    it("charges exactly the catalogue price", async () => {
      const h = harness();
      const { sagaId } = await h.place([{ sku: "SKU-LAMP-03", quantity: 3 }]);

      const settled = await h.orchestrator.advance(sagaId);
      const payment = await h.provider.find(h.stateOf(settled).paymentId ?? "");

      expect(payment?.amount).toEqual({ amountMinor: 3 * 4_250, currency: "GBP" });
      expect(payment?.status).toBe("succeeded");
    });
  });

  describe("a checkout that runs out of stock", () => {
    it("cancels the order without charging anybody", async () => {
      const h = harness();
      const { orderId, sagaId } = await h.place([{ sku: "SKU-SOLD-OUT", quantity: 1 }]);

      const settled = await h.orchestrator.advance(sagaId);

      expect(settled?.status).toBe("COMPENSATED");
      const order = await h.orders.find(orderId);
      expect(order?.status).toBe("CANCELLED");
      expect(order?.failureReason).toMatch(/Only 0 of "SKU-SOLD-OUT" available/);
      expect(h.shipping.booked).toHaveLength(0);
    });

    it("does not spend the retry ladder on an empty shelf", async () => {
      const h = harness();
      const { sagaId } = await h.place([{ sku: "SKU-SOLD-OUT", quantity: 1 }]);

      const settled = await h.orchestrator.advance(sagaId);

      // One attempt, one failure, straight to compensation: retrying would only
      // delay telling the customer.
      const failures = settled?.log.filter((entry) => entry.outcome === "failed") ?? [];
      expect(failures).toHaveLength(1);
      expect(failures[0]?.step).toBe("reserve-stock");
    });
  });

  describe("a checkout the carrier will not take", () => {
    it("refunds the money, releases the stock and cancels the order", async () => {
      // The full compensation path, and the reason `SERVICED_COUNTRIES` exists:
      // the pivot fails after everything before it succeeded.
      const h = harness();
      const { orderId, sagaId } = await h.place(LINES, "AQ");

      const settled = await h.orchestrator.advance(sagaId);

      expect(settled?.status).toBe("COMPENSATED");
      expect(h.inventory.stockOf("SKU-DESK-01")).toBe(25);

      const payment = await h.provider.find(h.stateOf(settled).paymentId ?? "");
      expect(payment?.status).toBe("refunded");
      expect(payment?.amountRefunded).toEqual({ amountMinor: 69_800, currency: "GBP" });

      const order = await h.orders.find(orderId);
      expect(order?.status).toBe("CANCELLED");
      expect(order?.failureReason).toBe('No carrier serves "AQ"');
    });

    it("announces the cancellation once everything is actually undone", async () => {
      const h = harness();
      const { sagaId } = await h.place(LINES, "AQ");

      await h.orchestrator.advance(sagaId);

      // `order.cancelled` is staged by the *last* compensation to run, so a
      // subscriber that acts on it — telling the customer their money is back —
      // is not lying.
      expect(staged(h.outboxStore)).toEqual(["order.placed", "order.cancelled"]);
    });

    it("compensates in reverse, skipping the pivot it cannot undo", async () => {
      const h = harness();
      const { sagaId } = await h.place(LINES, "AQ");

      const settled = await h.orchestrator.advance(sagaId);

      expect(
        settled?.log.map((entry) => `${entry.direction}:${entry.step}:${entry.outcome}`),
      ).toEqual([
        "forward:accept-order:completed",
        "forward:reserve-stock:completed",
        "forward:charge-payment:completed",
        "forward:create-shipment:failed",
        "backward:create-shipment:skipped",
        "backward:charge-payment:completed",
        "backward:reserve-stock:completed",
        "backward:accept-order:completed",
      ]);
    });
  });

  describe("idempotency, which at-least-once execution makes mandatory", () => {
    it("does not charge twice when the charge step's progress write was lost", async () => {
      // The crash window the whole design turns on: `charge-payment` returned,
      // the money moved, and the process died before the orchestrator could
      // write that it had. On recovery the step runs again — and must not be a
      // second charge.
      const h = harness();
      const { sagaId } = await h.place();

      // Stop the saga just after the charge, by making the carrier briefly
      // unreachable. A transient failure leaves the instance due for a retry
      // rather than compensating, which is the state a crash would leave too.
      const carrier = jest
        .spyOn(h.shipping, "createShipment")
        .mockRejectedValueOnce(new Error("carrier unreachable"));

      const stalled = await h.orchestrator.advance(sagaId);
      const charged = h.stateOf(stalled).paymentId;
      expect(charged).toMatch(/^pay_mock_/);

      loseLastWrite(h, sagaId, 2, ["paymentId"]);

      const settled = await h.orchestrator.advance(sagaId, new Date(Date.now() + 60_000));

      expect(settled?.status).toBe("COMPLETED");
      // The same payment, found again through its reference rather than created
      // a second time.
      expect(h.stateOf(settled).paymentId).toBe(charged);
      expect((await h.provider.find(charged ?? ""))?.amount.amountMinor).toBe(69_800);
      // One hold, one parcel, one confirmation.
      expect(h.inventory.stockOf("SKU-DESK-01")).toBe(23);
      expect(h.shipping.booked).toHaveLength(1);
      expect(staged(h.outboxStore)).toEqual(["order.placed", "order.confirmed"]);
      expect(carrier).toHaveBeenCalledTimes(2);
    });

    it("does not confirm twice when a finished saga is replayed from the start", async () => {
      // Not reachable through the orchestrator, which never rewinds a completed
      // instance — but the first step used to write `PROCESSING`
      // unconditionally, so a replay pushed a confirmed order backwards and the
      // last step then staged a second `order.confirmed`. The guard in
      // `accept-order` is what this pins.
      const h = harness();
      const { orderId, sagaId } = await h.place();
      await h.orchestrator.advance(sagaId);

      loseLastWrite(h, sagaId, 0, ["reservationId", "paymentId", "shipmentId"]);
      const replayed = await h.orchestrator.advance(sagaId);

      expect(replayed?.status).toBe("COMPLETED");
      expect((await h.orders.find(orderId))?.status).toBe("CONFIRMED");
      expect(staged(h.outboxStore)).toEqual(["order.placed", "order.confirmed"]);
    });

    it("releases a hold whose confirmation the saga never received", async () => {
      // The lost-response case the caller-assigned reservation id exists for:
      // the warehouse took the hold, the saga never learned its id, and the
      // compensation still has to give it back.
      const h = harness();
      const { sagaId } = await h.place();
      await h.inventory.reserve({
        orderId: "order-1",
        reservationId: `${sagaId}:reserve-stock`,
        lines: [...LINES],
      });
      expect(h.inventory.stockOf("SKU-DESK-01")).toBe(23);

      const step = h.saga.definition.steps[1];
      if (step?.kind !== "compensatable") throw new Error("reserve-stock must be compensatable");
      await step.compensate({
        sagaId,
        state: {
          orderId: "order-1",
          userId: USER,
          currency: "GBP",
          totalMinor: 1,
          shippingCountry: "GB",
          lines: [...LINES],
          // Null: the step never got to write it down.
          reservationId: null,
          paymentId: null,
          shipmentId: null,
        },
        idempotencyKey: `${sagaId}:reserve-stock`,
        correlationId: null,
      });

      expect(h.inventory.stockOf("SKU-DESK-01")).toBe(25);
    });
  });
});

/**
 * Rewinds an instance to just before the step at `cursor`, as a lost write
 * would.
 *
 * This is the one state a spec cannot reach through the orchestrator, because
 * the orchestrator's whole job is to never lose a write: the step ran, its side
 * effect happened at another service, and the process died before the row was
 * updated. Recovery then re-runs a step whose work is already done — which is
 * what "at-least-once" means and why every participant is idempotent.
 *
 * The log is truncated to the steps that were still recorded, so
 * `assertResumable` sees a coherent history rather than one that mentions a
 * step the cursor says has not run.
 */
function loseLastWrite(
  h: ReturnType<typeof harness>,
  sagaId: string,
  cursor: number,
  forgotten: readonly (keyof CheckoutSagaState)[],
): void {
  const instance = h.sagaStore.all().find((row) => row.id === sagaId);
  if (!instance) throw new Error(`No saga ${sagaId}`);

  const completed = instance.log.filter(
    (entry) => entry.direction === "forward" && entry.outcome === "completed",
  );
  const state = { ...instance.state } as Record<string, unknown>;
  for (const key of forgotten) state[key] = null;

  h.sagaStore.replace({
    ...instance,
    status: "RUNNING",
    cursor,
    attempts: 0,
    nextAttemptAt: new Date(),
    log: completed.slice(0, cursor),
    lastError: null,
    lockedBy: null,
    lockedUntil: null,
    state: state as typeof instance.state,
  });
}
