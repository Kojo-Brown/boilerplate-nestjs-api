import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { PrismaOrderStore } from "@/orders";
import type { OrderStore } from "@/orders";
import { asPrismaService, createClient, uniqueEmail } from "./helpers/db";

/**
 * `PrismaOrderStore` against a real Postgres.
 *
 * There is no in-memory contract to share here, unlike the saga and outbox
 * stores, because nothing about this adapter is concurrent — an order is only
 * ever written by the saga that owns it, and that contention is settled once in
 * `PrismaSagaStore`. What is worth asking a real server is narrower and not
 * checkable anywhere else: that the migration produced the table the client
 * expects, that `items` survives a `jsonb` round trip as an array of lines, and
 * that the cursor pages over a stable order.
 */
describe("PrismaOrderStore (Postgres)", () => {
  let client: PrismaClient;
  let store: OrderStore;
  let transactions: PrismaTransactionRunner;
  let userId: string;

  beforeAll(async () => {
    client = createClient();
    store = new PrismaOrderStore(asPrismaService(client));
    transactions = new PrismaTransactionRunner(asPrismaService(client));
  });

  afterAll(async () => {
    await truncate(client);
    await client.$disconnect();
  });

  beforeEach(async () => {
    await truncate(client);
    const user = await client.user.create({
      data: { email: uniqueEmail("order-store"), name: "Buyer" },
    });
    userId = user.id;
  });

  /** An order needs a saga row only by convention; the column is not a foreign key. */
  const create = (overrides: { id?: string; country?: string } = {}) =>
    transactions.run((tx) =>
      store.create(tx, {
        id: overrides.id ?? randomUUID(),
        userId,
        items: [
          { sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 },
          { sku: "SKU-LAMP-03", quantity: 1, unitPriceMinor: 4_250 },
        ],
        total: { amountMinor: 74_050, currency: "GBP" },
        shippingCountry: overrides.country ?? "GB",
        sagaId: randomUUID(),
      }),
    );

  it("round-trips the lines through jsonb, in order", async () => {
    const created = await create();

    const read = await store.find(created.id);
    expect(read?.items).toEqual([
      { sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 },
      { sku: "SKU-LAMP-03", quantity: 1, unitPriceMinor: 4_250 },
    ]);
    expect(read?.total).toEqual({ amountMinor: 74_050, currency: "GBP" });
    expect(read?.status).toBe("PENDING");
  });

  it("discards the order when the unit of work fails", async () => {
    // The property `PlaceOrderHandler` depends on: an order that commits without
    // the saga that drives it is an order nothing will ever advance.
    const id = randomUUID();
    await expect(
      transactions.run(async (tx) => {
        await store.create(tx, {
          id,
          userId,
          items: [],
          total: { amountMinor: 0, currency: "GBP" },
          shippingCountry: "GB",
          sagaId: randomUUID(),
        });
        throw new Error("the saga could not be written");
      }),
    ).rejects.toThrow("the saga could not be written");

    expect(await store.find(id)).toBeNull();
  });

  it("records a cancellation with its reason", async () => {
    const created = await create();

    const cancelled = await transactions.run((tx) =>
      store.transition(tx, created.id, {
        status: "CANCELLED",
        failureReason: 'No carrier serves "AQ"',
      }),
    );

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.failureReason).toBe('No carrier serves "AQ"');
  });

  it("clears the reason on a transition that does not name one", async () => {
    // A transition that does not mention a reason is clearing one; otherwise an
    // order cancelled, retried and confirmed would keep the failure text of the
    // attempt that did not happen.
    const created = await create();
    await transactions.run((tx) =>
      store.transition(tx, created.id, { status: "CANCELLED", failureReason: "declined" }),
    );

    const confirmed = await transactions.run((tx) =>
      store.transition(tx, created.id, { status: "CONFIRMED" }),
    );

    expect(confirmed.failureReason).toBeNull();
  });

  it("rejects a transition for an order that is not there", async () => {
    await expect(
      transactions.run((tx) => store.transition(tx, randomUUID(), { status: "CONFIRMED" })),
    ).rejects.toThrow();
  });

  it("lists newest first and pages over a stable order", async () => {
    const first = await create();
    const second = await create();
    const third = await create();

    const page = await store.listForUser({ userId, limit: 2 });
    // `limit + 1`, which is what tells `buildCursorPage` there is a next page.
    expect(page).toHaveLength(3);
    expect(page.slice(0, 2).map((order) => order.id)).toEqual([third.id, second.id]);

    const next = await store.listForUser({ userId, limit: 2, cursor: second.id });
    expect(next.map((order) => order.id)).toEqual([first.id]);
  });

  it("shows one customer nothing of another's", async () => {
    await create();
    const other = await client.user.create({
      data: { email: uniqueEmail("order-store-other"), name: "Someone else" },
    });

    expect(await store.listForUser({ userId: other.id, limit: 10 })).toEqual([]);
  });

  it("goes with the account, because the row is theirs", async () => {
    // `onDelete: Cascade`. An order that outlived its owner is a row nobody can
    // read and nobody can delete through the API.
    const created = await create();
    await client.user.delete({ where: { id: userId } });

    expect(await store.find(created.id)).toBeNull();
  });
});

async function truncate(client: PrismaClient): Promise<void> {
  await client.order.deleteMany({});
  await client.sagaInstance.deleteMany({});
  await client.user.deleteMany({});
}
