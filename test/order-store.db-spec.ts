import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { FieldDecryptionError } from "@/crypto";
import { PrismaOrderStore } from "@/orders";
import type { OrderStore } from "@/orders";
import { createTestFieldEncryption } from "@/test-utils/test-field-encryption";
import type { FieldEncryptionService } from "@/crypto/field-encryption.service";
import { asPrismaService, createClient, uniqueEmail } from "./helpers/db";

/**
 * `PrismaOrderStore` against a real Postgres.
 *
 * There is no in-memory contract to share here, unlike the saga and outbox
 * stores, because nothing about this adapter is concurrent — an order is only
 * ever written by the saga that owns it, and that contention is settled once in
 * `PrismaSagaStore`. What is worth asking a real server is narrower and not
 * checkable anywhere else: that the migration produced the table the client
 * expects, that the lines survive a round trip through an encrypted `bytea`
 * column, and that the cursor pages over a stable order.
 *
 * The encryption is the real thing, on the local key provider — the same
 * envelope, the same authenticated data, the same refusals as the KMS path, with
 * no network. So the last three specs below are asserting properties of what
 * production does: that the column holds no plaintext, that a value moved to
 * another row will not decrypt there, and that an edited byte is refused rather
 * than read.
 */
describe("PrismaOrderStore (Postgres)", () => {
  let client: PrismaClient;
  let store: OrderStore;
  let transactions: PrismaTransactionRunner;
  let cipher: FieldEncryptionService;
  let userId: string;

  beforeAll(async () => {
    client = createClient();
    cipher = createTestFieldEncryption();
    store = new PrismaOrderStore(asPrismaService(client), cipher);
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

  it("round-trips the lines through the encrypted column, in order", async () => {
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

  it("stores no plaintext a `SELECT` or a backup would show", async () => {
    // The whole point, and the one assertion that cannot be made anywhere but
    // against a real column: what is on disk. `store.find` proves a round trip
    // and would look identical if the column were still jsonb.
    const created = await create();

    const row = await client.order.findUniqueOrThrow({
      where: { id: created.id },
      select: { itemsCiphertext: true },
    });
    const stored = Buffer.from(row.itemsCiphertext);

    expect(stored.includes("SKU-DESK-01")).toBe(false);
    expect(stored.includes("34900")).toBe(false);
    expect(stored.toString("utf8")).not.toContain("sku");
    // And it is an envelope rather than something that merely is not the
    // plaintext: format version 1, then a wrapped data key.
    expect(stored.readUInt8(0)).toBe(1);
    expect(stored.readUInt16BE(1)).toBeGreaterThan(0);
  });

  it("will not decrypt a value moved to another order's row", async () => {
    // The attack the record binding closes: whoever can write this table copies
    // a victim's ciphertext onto a row they own and asks the API to render it.
    // Postgres accepts the write — it is just bytes — and the read refuses.
    const victim = await create();
    const attacker = await create();
    const stolen = await client.order.findUniqueOrThrow({
      where: { id: victim.id },
      select: { itemsCiphertext: true },
    });

    await client.order.update({
      where: { id: attacker.id },
      data: { itemsCiphertext: stolen.itemsCiphertext },
    });

    await expect(store.find(attacker.id)).rejects.toThrow(FieldDecryptionError);
    // The victim's own row is untouched and still reads.
    expect((await store.find(victim.id))?.items).toHaveLength(2);
  });

  it("will not read a value with a byte changed", async () => {
    const created = await create();
    const row = await client.order.findUniqueOrThrow({
      where: { id: created.id },
      select: { itemsCiphertext: true },
    });
    const tampered = Buffer.from(row.itemsCiphertext);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0x01, tampered.length - 1);

    await client.order.update({
      where: { id: created.id },
      data: { itemsCiphertext: new Uint8Array(tampered) },
    });

    await expect(store.find(created.id)).rejects.toThrow(FieldDecryptionError);
  });

  it("cannot be read by a deployment holding another master key", async () => {
    // What makes rotating the master key a migration rather than an edit, and
    // what a stolen backup buys without the key: nothing.
    const created = await create();
    const elsewhere = new PrismaOrderStore(asPrismaService(client), createTestFieldEncryption());

    await expect(elsewhere.find(created.id)).rejects.toThrow(FieldDecryptionError);
  });

  it("reads a page of rows written under one data key", async () => {
    // Every row on the page carries the wrapped key it was written under, and the
    // materials cache coalesces them, so this is one unwrap rather than three.
    await create();
    await create();
    await create();
    cipher.clearKeyCache();

    const page = await store.listForUser({ userId, limit: 10 });

    expect(page).toHaveLength(3);
    expect(page.every((order) => order.items.length === 2)).toBe(true);
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
