import { TransactionalOutbox } from "@/outbox";
import { SagaOrchestrator, SagaRegistry, defineSaga } from "@/saga";
import type { SagaState, SagaStore } from "@/saga";
import { InMemoryOrderStore } from "@/test-utils/in-memory-order.store";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { realEventContract } from "@/test-utils/event-contract";
import { stubConfig } from "@/test-utils/stub-config";
import { CHECKOUT_SAGA } from "../checkout.saga";
import { UnknownSkuError } from "../catalogue";
import { PlaceOrderCommand, PlaceOrderHandler } from "./place-order.command";

const CONFIG = {
  SAGA_LEASE_MS: 60_000,
  SAGA_STEP_TIMEOUT_MS: 5_000,
  SAGA_BACKOFF_BASE_MS: 1_000,
  SAGA_BACKOFF_MAX_MS: 60_000,
  SAGA_MAX_ATTEMPTS: 2,
};

const USER = "user-1";

/**
 * The handler with a **trivial saga** registered under the checkout's name.
 *
 * Deliberately not the real `CheckoutSaga`: what this spec is about is the
 * transaction boundary — order, instance and event committing together, and the
 * advance happening strictly after — and running five real steps behind it
 * would make every assertion depend on a warehouse and a gateway.
 * `checkout.saga.spec.ts` is where the steps are exercised.
 */
function harness() {
  const orders = new InMemoryOrderStore();
  const transactions = new InMemoryTransactionRunner();
  const outboxStore = new InMemoryOutboxStore();
  const outbox = new TransactionalOutbox(outboxStore, realEventContract());
  const sagaStore = new InMemorySagaStore();
  const registry = new SagaRegistry();
  const ran: string[] = [];

  registry.register(
    defineSaga<SagaState>(CHECKOUT_SAGA, [
      {
        name: "only",
        kind: "compensatable",
        execute: async () => {
          ran.push("only");
          return {};
        },
        compensate: async () => {
          ran.push("undo:only");
        },
      },
    ]),
  );

  const orchestrator = new SagaOrchestrator(sagaStore, registry, stubConfig(CONFIG), () => 0.5);
  const handler = new PlaceOrderHandler(orders, transactions, outbox, orchestrator);

  return { orders, transactions, outboxStore, sagaStore, orchestrator, handler, ran };
}

const command = (shippingCountry = "GB") =>
  new PlaceOrderCommand(USER, {
    lines: [
      { sku: "SKU-DESK-01", quantity: 1 },
      { sku: "SKU-LAMP-03", quantity: 2 },
    ],
    shippingCountry,
  });

describe("PlaceOrderHandler", () => {
  it("prices the basket from the catalogue, not from the request", async () => {
    const h = harness();

    const order = await h.handler.execute(command());

    expect(order.total).toEqual({ amountMinor: 34_900 + 2 * 4_250, currency: "GBP" });
    expect(order.items).toEqual([
      { sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 },
      { sku: "SKU-LAMP-03", quantity: 2, unitPriceMinor: 4_250 },
    ]);
  });

  it("writes the order, its saga and the event in one unit of work", async () => {
    const h = harness();

    const order = await h.handler.execute(command());

    expect(h.transactions.started).toBe(1);
    expect(h.transactions.committed).toBe(1);
    const instance = await h.sagaStore.find(order.sagaId);
    expect(instance?.name).toBe(CHECKOUT_SAGA);
    expect(h.outboxStore.all().map((row) => row.name)).toEqual(["order.placed"]);
  });

  it("ties the order to its saga in both directions", async () => {
    const h = harness();

    const order = await h.handler.execute(command());
    const instance = await h.sagaStore.find(order.sagaId);

    expect((instance?.state as { orderId?: string }).orderId).toBe(order.id);
  });

  it("normalises the destination before the saga ever sees it", async () => {
    const h = harness();

    const order = await h.handler.execute(command("gb"));

    expect(order.shippingCountry).toBe("GB");
  });

  it("advances the saga only after the transaction has committed", async () => {
    const h = harness();
    const order = await h.handler.execute(command());

    // A step that ran inside the transaction would be a remote call holding a
    // database connection, and a step that failed would roll back the row that
    // records the attempt.
    expect(h.ran).toEqual(["only"]);
    expect((await h.sagaStore.find(order.sagaId))?.status).toBe("COMPLETED");
  });

  it("refuses an unknown SKU before anything is written", async () => {
    const h = harness();

    await expect(
      h.handler.execute(
        new PlaceOrderCommand(USER, {
          lines: [{ sku: "SKU-IMAGINARY", quantity: 1 }],
          shippingCountry: "GB",
        }),
      ),
    ).rejects.toThrow(UnknownSkuError);

    expect(h.orders.all()).toHaveLength(0);
    expect(h.sagaStore.all()).toHaveLength(0);
    expect(h.transactions.started).toBe(0);
  });

  it("still answers with the order when the saga machinery itself fails", async () => {
    // The order and its instance are committed, so the recovery poller will
    // pick it up. A 500 here would tell the customer nothing happened, about a
    // checkout that is very much alive.
    const h = harness();
    jest
      .spyOn(h.orchestrator, "advance")
      .mockRejectedValueOnce(new Error("the saga store is unreachable"));

    const order = await h.handler.execute(command());

    expect(order.status).toBe("PENDING");
    expect(await h.sagaStore.find(order.sagaId)).not.toBeNull();
  });

  it("leaves nothing behind when the unit of work fails", async () => {
    const h = harness();
    const store: SagaStore = h.sagaStore;
    jest.spyOn(store, "create").mockRejectedValueOnce(new Error("saga table is gone"));

    await expect(h.handler.execute(command())).rejects.toThrow("saga table is gone");

    expect(h.orders.all()).toHaveLength(0);
    expect(h.outboxStore.all()).toHaveLength(0);
  });
});
