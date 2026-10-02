import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { PrismaOrderStore } from "@/orders";
import { ListOrdersHandler, ListOrdersQuery } from "@/orders/read";
import { CHECKOUT_SAGA } from "@/orders/checkout.saga";
import { PrismaSagaStore, SagaLoaders, SagaRegistry, defineSaga } from "@/saga";
import type { SagaState } from "@/saga";
import { createTestFieldEncryption } from "@/test-utils/test-field-encryption";
import { measureQueryGrowth } from "@/test-utils/n-plus-one";
import type { CallRecorder } from "@/test-utils/n-plus-one";
import { TEST_TENANT_ID, asPrismaService, createClient, uniqueEmail } from "./helpers/db";
import { probePrismaQueries } from "./helpers/prisma-query-probe";
import type { PrismaService } from "@/common/prisma/prisma.service";
import { runInTenant } from "@/tenancy";

/**
 * The orders read path against a real Postgres, counting statements.
 *
 * `src/orders/read/list-orders.query.spec.ts` asserts the same property against
 * doubles and runs on every push; this is the half that cannot be satisfied by
 * a double whose batch read loops, and the half that would notice the ORM
 * issuing a statement nobody wrote. The numbers below are what a page of orders
 * costs: one statement for the page, one for every saga it names, and one to name
 * the tenant the page is read as — at any size.
 *
 * No skip-if-absent branch, for the reason `test/helpers/db.ts` gives.
 */
/**
 * `it`, with the suite's tenant in scope for the body.
 *
 * `PrismaOrderStore` reads through a tenant-scoped client, which refuses to run with no
 * tenant in scope — and a read that did reach Postgres without one would be filtered
 * to nothing by the policies anyway. This suite is about the read model's SQL, so it runs
 * as the one tenant its rows belong to; `test/tenant-isolation.db-spec.ts` is where
 * the policies themselves are asked.
 *
 * A wrapper rather than a `beforeEach`, and that is not a style choice: an
 * `AsyncLocalStorage` scope belongs to the execution context that opens it, and a
 * jest hook's context is not an ancestor of the test's once more than one suite
 * shares the process. A tenant entered in a hook is visible in that hook and gone by
 * the time the body runs — which fails loudly here, and is worth knowing about
 * anywhere else the same shortcut is reached for.
 */
function tenantedIt(name: string, body: () => Promise<void>): void {
  it(name, () => runInTenant(TEST_TENANT_ID, body));
}

describe("ListOrdersHandler (Postgres)", () => {
  let client: PrismaService;
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
    // One cipher for both stores, not one each: two services would hold two
    // random master keys, and the seeded rows would then be unreadable by the
    // handler — a failure that arrives as "could not decrypt" several
    // assertions later rather than as a wiring mistake here.
    const cipher = createTestFieldEncryption();
    seedOrders = new PrismaOrderStore(asPrismaService(client), cipher);
    seedSagas = new PrismaSagaStore(asPrismaService(client));
    handler = new ListOrdersHandler(
      new PrismaOrderStore(asPrismaService(probed.client), cipher),
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

  tenantedIt("reads a page and every saga on it", async () => {
    await seed(3);
    recorder.reset();

    const page = await handler.execute(new ListOrdersQuery(userId, { limit: 20 }));

    expect(page.items).toHaveLength(3);
    expect(page.items.map((view) => view.fulfilment.step)).toEqual([
      "accept-order",
      "accept-order",
      "accept-order",
    ]);
    // Three statements, and the third one is the tenant: `PrismaOrderStore`'s read
    // goes through the tenant-scoped client, which puts `set_config` and the query in
    // one transaction (see `tenantScopeExtension`). It is one extra statement per
    // *operation* and not per row, which is the property this suite is about — the
    // count below is flat at every page size. The saga read is not scoped because
    // `saga_instances` has no tenant column and no policy.
    expect(recorder.calls).toEqual(["Order.findMany", "$raw.$executeRaw", "SagaInstance.findMany"]);
  });

  tenantedIt("costs the same three statements at any page size", async () => {
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

    expect(growth.countsBySize).toEqual({ 1: 3, 20: 3, 100: 3 });
  });

  tenantedIt("still answers when an order's saga instance has been deleted", async () => {
    await seed(2);
    await client.sagaInstance.deleteMany({});
    recorder.reset();

    const page = await handler.execute(new ListOrdersQuery(userId, { limit: 20 }));

    // The same statements still, and two orders still: a missing instance is an
    // empty fulfilment, not a failed page and not a second lookup.
    expect(page.items).toHaveLength(2);
    expect(page.items.map((view) => view.fulfilment.status)).toEqual([null, null]);
    expect(recorder.calls).toEqual(["Order.findMany", "$raw.$executeRaw", "SagaInstance.findMany"]);
  });
});

/** Orders cascade from their user; saga instances are nobody's child. */
async function truncate(client: PrismaClient): Promise<void> {
  await client.sagaInstance.deleteMany({});
  await client.user.deleteMany({});
}
