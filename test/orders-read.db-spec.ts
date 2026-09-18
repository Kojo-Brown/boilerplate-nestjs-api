import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { PrismaOrderStore } from "@/orders";
import { ListOrdersHandler, ListOrdersQuery } from "@/orders/read";
import { CHECKOUT_SAGA } from "@/orders/checkout.saga";
import { PrismaSagaStore, SagaLoaders, SagaRegistry, defineSaga } from "@/saga";
import type { SagaState } from "@/saga";
import { measureQueryGrowth } from "@/test-utils/n-plus-one";
import type { CallRecorder } from "@/test-utils/n-plus-one";
import { asPrismaService, createClient, uniqueEmail } from "./helpers/db";
import { probePrismaQueries } from "./helpers/prisma-query-probe";

/**
 * The orders read path against a real Postgres, counting statements.
 *
 * `src/orders/read/list-orders.query.spec.ts` asserts the same property against
 * doubles and runs on every push; this is the half that cannot be satisfied by
 * a double whose batch read loops, and the half that would notice the ORM
 * issuing a statement nobody wrote. The numbers below are what a page of orders
 * costs: one statement for the page, one for every saga it names, at any size.
 *
 * No skip-if-absent branch, for the reason `test/helpers/db.ts` gives.
 */
describe("ListOrdersHandler (Postgres)", () => {
  let client: PrismaClient;
  let handler: ListOrdersHandler;
  let transactions: PrismaTransactionRunner;
  let seedOrders: PrismaOrderStore;
  let seedSagas: PrismaSagaStore;
  let recorder: CallRecorder;
  let userId: string;

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

  beforeAll(() => {
    client = createClient();
    // One connection, two views of it: the handler's stores go through the
    // probe, the seeding below does not, so every statement counted is one the
    // handler issued.
    const probed = probePrismaQueries(client);
    recorder = probed.recorder;

    transactions = new PrismaTransactionRunner(asPrismaService(client));
    seedOrders = new PrismaOrderStore(asPrismaService(client));
    seedSagas = new PrismaSagaStore(asPrismaService(client));
    handler = new ListOrdersHandler(
      new PrismaOrderStore(asPrismaService(probed.client)),
      new SagaLoaders(new PrismaSagaStore(asPrismaService(probed.client))),
      registry,
    );
  });

  afterAll(async () => {
    await truncate(client);
    await client.$disconnect();
  });

  const seed = async (count: number): Promise<void> => {
    await truncate(client);
    const user = await client.user.create({
      data: { email: uniqueEmail("orders-read"), name: "Buyer" },
    });
    userId = user.id;

    for (let index = 0; index < count; index += 1) {
      const sagaId = randomUUID();
      await transactions.run(async (tx) => {
        await seedSagas.create(tx, {
          id: sagaId,
          name: CHECKOUT_SAGA,
          state: { orderId: `order-${index}` },
          correlationId: null,
        });
        await seedOrders.create(tx, {
          id: randomUUID(),
          userId,
          items: [{ sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 }],
          total: { amountMinor: 34_900, currency: "GBP" },
          shippingCountry: "GB",
          sagaId,
        });
      });
    }
  };

  it("reads a page and every saga on it", async () => {
    await seed(3);
    recorder.reset();

    const page = await handler.execute(new ListOrdersQuery(userId, { limit: 20 }));

    expect(page.items).toHaveLength(3);
    expect(page.items.map((view) => view.fulfilment.step)).toEqual([
      "accept-order",
      "accept-order",
      "accept-order",
    ]);
    expect(recorder.calls).toEqual(["Order.findMany", "SagaInstance.findMany"]);
  });

  it("costs the same two statements at any page size", async () => {
    const growth = await measureQueryGrowth({
      // Twenty is the default page size and a hundred is the DTO's ceiling, so
      // the largest size here is the worst page the endpoint can be asked for.
      sizes: [1, 20, 100],
      recorders: [recorder],
      run: async (size) => {
        await seed(size);
        recorder.reset();
        await handler.execute(new ListOrdersQuery(userId, { limit: size }));
      },
    });

    expect(growth.countsBySize).toEqual({ 1: 2, 20: 2, 100: 2 });
  });

  it("still answers when an order's saga instance has been deleted", async () => {
    await seed(2);
    await client.sagaInstance.deleteMany({});
    recorder.reset();

    const page = await handler.execute(new ListOrdersQuery(userId, { limit: 20 }));

    // Two statements still, and two orders still: a missing instance is an
    // empty fulfilment, not a failed page and not a second lookup.
    expect(page.items).toHaveLength(2);
    expect(page.items.map((view) => view.fulfilment.status)).toEqual([null, null]);
    expect(recorder.calls).toEqual(["Order.findMany", "SagaInstance.findMany"]);
  });
});

/** Orders cascade from their user; saga instances are nobody's child. */
async function truncate(client: PrismaClient): Promise<void> {
  await client.sagaInstance.deleteMany({});
  await client.user.deleteMany({});
}
