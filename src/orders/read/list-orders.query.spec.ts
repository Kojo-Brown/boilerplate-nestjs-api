import { SagaLoaders, SagaRegistry, defineSaga } from "@/saga";
import type { SagaState, SagaStore } from "@/saga";
import { InMemoryOrderStore } from "@/test-utils/in-memory-order.store";
import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { measureQueryGrowth, recordCalls } from "@/test-utils/n-plus-one";
import type { OrderStore } from "../ports";
import { CHECKOUT_SAGA } from "../checkout.saga";
import { ListOrdersHandler, ListOrdersQuery } from "./list-orders.query";

const USER = "user-1";

function registry(): SagaRegistry {
  const sagas = new SagaRegistry();
  sagas.register(
    defineSaga<SagaState>(CHECKOUT_SAGA, [
      {
        name: "accept-order",
        kind: "compensatable",
        execute: async () => undefined,
        compensate: async () => undefined,
      },
    ]),
  );
  return sagas;
}

/**
 * The handler wired to doubles, with every read into both stores recorded.
 *
 * The recorders wrap the stores rather than the handler, because an N+1 is
 * invisible from outside: the endpoint answers the same page either way, and
 * the only difference is how many times it asked the database. Seeding goes
 * through the raw stores so that the counts are the handler's alone.
 */
function harness() {
  const orderStore = new InMemoryOrderStore();
  const sagaStore = new InMemorySagaStore();
  const orders = recordCalls<OrderStore>(orderStore, "OrderStore");
  const sagas = recordCalls<SagaStore>(sagaStore, "SagaStore");
  const transactions = new InMemoryTransactionRunner();
  const handler = new ListOrdersHandler(orders.subject, new SagaLoaders(sagas.subject), registry());

  const seed = async (count: number): Promise<void> => {
    orderStore.reset();
    sagaStore.reset();
    for (let index = 0; index < count; index += 1) {
      await transactions.run(async (tx) => {
        const instance = await sagaStore.create(tx, {
          id: `saga-${index}`,
          name: CHECKOUT_SAGA,
          state: { orderId: `order-${index}` },
          correlationId: null,
        });
        await orderStore.create(tx, {
          id: `order-${index}`,
          userId: USER,
          items: [{ sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 }],
          total: { amountMinor: 34_900, currency: "GBP" },
          shippingCountry: "GB",
          sagaId: instance.id,
        });
      });
    }
  };

  return {
    sagaStore,
    recorders: [orders.recorder, sagas.recorder],
    seed,
    list: (limit: number) => handler.execute(new ListOrdersQuery(USER, { limit })),
  };
}

describe("ListOrdersHandler", () => {
  it("returns the caller's orders with how each checkout is going", async () => {
    const h = harness();
    await h.seed(2);

    const page = await h.list(20);

    expect(page.items.map((view) => view.order.id).sort()).toEqual(["order-0", "order-1"]);
    expect(page.items.map((view) => view.fulfilment.step)).toEqual([
      "accept-order",
      "accept-order",
    ]);
  });

  it("renders an order whose saga instance is gone", async () => {
    // The miss the loader has to resolve as `null` rather than as a rejection.
    // Nothing prunes terminal instances today, but an order that outlives its
    // saga must still appear in the list rather than failing the whole page.
    const h = harness();
    await h.seed(1);
    h.sagaStore.reset();

    const page = await h.list(20);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.fulfilment.status).toBeNull();
    expect(page.items[0]?.fulfilment.step).toBeNull();
  });

  it("reads a page in a constant number of queries, whatever its size", async () => {
    // The regression this guards is the one this handler shipped with: one saga
    // read per order, so a page of twenty cost twenty-one round trips. Two is
    // the floor — the orders, then every saga they name — and the counts are
    // pinned rather than only checked for growth, so a second batched read
    // added later has to be justified here too.
    const h = harness();

    const growth = await measureQueryGrowth({
      sizes: [1, 2, 20],
      recorders: h.recorders,
      run: async (size) => {
        await h.seed(size);
        await h.list(size);
      },
    });

    expect(growth.constant).toBe(true);
    expect(growth.countsBySize).toEqual({ 1: 2, 2: 2, 20: 2 });
    expect(growth.callsBySize[20]).toEqual(["OrderStore.listForUser", "SagaStore.findMany"]);
  });
});
