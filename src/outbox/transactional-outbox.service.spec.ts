import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { SchemaValidationError } from "@/schema-registry";
import { realEventContract } from "@/test-utils/event-contract";
import { TransactionalOutbox } from "./transactional-outbox.service";

describe("TransactionalOutbox", () => {
  let store: InMemoryOutboxStore;
  let transactions: InMemoryTransactionRunner;
  let outbox: TransactionalOutbox;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
    transactions = new InMemoryTransactionRunner();
    outbox = new TransactionalOutbox(store, realEventContract());
  });

  const stage = (correlationId?: string) =>
    transactions.run((tx) =>
      outbox.stage(
        tx,
        "user.registered",
        { userId: "user-1", email: "staged@example.test", name: "Ada", provider: null },
        correlationId === undefined ? {} : { correlationId },
      ),
    );

  it("writes the event with the name and payload it was given", async () => {
    await stage();

    expect(store.all()).toEqual([
      expect.objectContaining({
        name: "user.registered",
        payload: { userId: "user-1", email: "staged@example.test", name: "Ada", provider: null },
      }),
    ]);
  });

  it("returns the identity the event will be published under", async () => {
    const staged = await stage();

    expect(store.all()[0]?.eventId).toBe(staged.eventId);
    expect(staged.name).toBe("user.registered");
  });

  it("mints a distinct id per event", async () => {
    const first = await stage();
    const second = await stage();

    expect(first.eventId).not.toBe(second.eventId);
  });

  it("carries the correlation id when the caller has one, and null when it does not", async () => {
    await stage("corr-1");
    await stage();

    expect(store.all().map((row) => row.correlationId)).toEqual(["corr-1", null]);
  });

  /**
   * `occurredAt` is stamped when the event is staged, not when it is relayed.
   * A relay that is an hour behind — or a row that has been retried for an
   * hour — must not make the event look like it happened just now.
   */
  it("stamps the time the event happened, which is inside the transaction", async () => {
    const before = Date.now();
    const staged = await stage();
    const after = Date.now();

    expect(staged.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(staged.occurredAt.getTime()).toBeLessThanOrEqual(after);
  });

  describe("the schema contract", () => {
    it("refuses a payload the event's schema does not accept", async () => {
      // TypeScript has already had its say about this payload; it says nothing
      // about a field that is `undefined` at runtime because a nullable column
      // came back empty. Left to the relay, this is durable garbage — a row
      // that fails to publish, retries, and dead-letters minutes later in a
      // background poller, nowhere near the code that produced it.
      await expect(
        transactions.run((tx) =>
          outbox.stage(tx, "user.registered", {
            userId: "user-1",
            email: "staged@example.test",
            name: undefined as unknown as string,
            provider: null,
          }),
        ),
      ).rejects.toThrow(SchemaValidationError);
    });

    it("leaves no row behind when the payload is refused", async () => {
      await expect(
        transactions.run((tx) =>
          outbox.stage(tx, "user.deleted", { userId: "user-1" } as unknown as {
            userId: string;
            email: string;
          }),
        ),
      ).rejects.toThrow(SchemaValidationError);

      // Thrown before the insert, so the caller's transaction fails and the
      // operation the event would have announced rolls back with it.
      expect(store.all()).toEqual([]);
    });
  });

  it("stages into the caller's unit of work rather than opening its own", async () => {
    const seen: string[] = [];
    const spy = {
      stage: (tx: { backend: string }) => {
        seen.push(tx.backend);
        return Promise.resolve();
      },
    };

    await transactions.run((tx) =>
      new TransactionalOutbox(spy as never, realEventContract()).stage(tx, "user.deleted", {
        userId: "user-1",
        email: "gone@example.test",
      }),
    );

    expect(seen).toEqual(["in-memory"]);
    expect(transactions.started).toBe(1);
  });

  it("leaves nothing behind when the unit of work fails", async () => {
    await expect(
      transactions.run(async (tx) => {
        await outbox.stage(tx, "user.deleted", { userId: "user-1", email: "gone@example.test" });
        throw new Error("the write after it failed");
      }),
    ).rejects.toThrow("the write after it failed");

    expect(store.all()).toEqual([]);
  });
});
