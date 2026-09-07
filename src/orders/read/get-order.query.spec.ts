import { SagaRegistry, defineSaga } from "@/saga";
import type { SagaState } from "@/saga";
import { InMemoryOrderStore } from "@/test-utils/in-memory-order.store";
import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { CHECKOUT_SAGA } from "../checkout.saga";
import { OrderNotFoundError } from "../orders.errors";
import { GetOrderHandler, GetOrderQuery } from "./get-order.query";

const OWNER: Pick<AuthenticatedUser, "id" | "role"> = { id: "user-1", role: "USER" };
const STRANGER: Pick<AuthenticatedUser, "id" | "role"> = { id: "user-2", role: "USER" };
const ADMIN: Pick<AuthenticatedUser, "id" | "role"> = { id: "user-3", role: "ADMIN" };

async function harness() {
  const orders = new InMemoryOrderStore();
  const sagas = new InMemorySagaStore();
  const registry = new SagaRegistry();
  registry.register(
    defineSaga<SagaState>(CHECKOUT_SAGA, [
      {
        name: "accept-order",
        kind: "compensatable",
        execute: async () => undefined,
        compensate: async () => undefined,
      },
    ]),
  );
  const transactions = new InMemoryTransactionRunner();

  const order = await transactions.run(async (tx) => {
    const instance = await sagas.create(tx, {
      id: "saga-1",
      name: CHECKOUT_SAGA,
      state: { orderId: "order-1" },
      correlationId: null,
    });
    return orders.create(tx, {
      id: "order-1",
      userId: OWNER.id,
      items: [{ sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 }],
      total: { amountMinor: 34_900, currency: "GBP" },
      shippingCountry: "GB",
      sagaId: instance.id,
    });
  });

  return { handler: new GetOrderHandler(orders, sagas, registry), order };
}

describe("GetOrderHandler", () => {
  it("returns the order and how its checkout is going", async () => {
    const h = await harness();

    const view = await h.handler.execute(new GetOrderQuery("order-1", OWNER));

    expect(view.order.id).toBe("order-1");
    expect(view.fulfilment.sagaId).toBe("saga-1");
    expect(view.fulfilment.step).toBe("accept-order");
  });

  it("lets an administrator read anybody's order", async () => {
    const h = await harness();
    await expect(h.handler.execute(new GetOrderQuery("order-1", ADMIN))).resolves.toBeDefined();
  });

  it("answers 404 for somebody else's order, not 403", async () => {
    // A 403 confirms the id exists, which makes the endpoint an oracle for
    // guessing order ids. Nothing about an order id is public.
    const h = await harness();

    await expect(h.handler.execute(new GetOrderQuery("order-1", STRANGER))).rejects.toThrow(
      OrderNotFoundError,
    );
  });

  it("answers 404 for an order nobody placed", async () => {
    const h = await harness();
    await expect(h.handler.execute(new GetOrderQuery("order-9", OWNER))).rejects.toThrow(
      OrderNotFoundError,
    );
  });
});
