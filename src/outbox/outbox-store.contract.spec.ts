import { EMPTY_TRACE_CARRIER } from "@/telemetry";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { describeOutboxStoreContract } from "./outbox-store.contract";

/**
 * The contract against the in-memory double.
 *
 * `PrismaOutboxStore` is held to the same contract by
 * `test/outbox-store.db-spec.ts`, which needs a real Postgres: the exclusion
 * between two relays *is* `FOR UPDATE SKIP LOCKED`, and the atomicity of a
 * staged event *is* the transaction it was written in. Neither can be stood in
 * for — a double that reproduced them would be reimplementing the thing under
 * test — so the adapter's absence from this suite is deliberate.
 *
 * What this half is for is the e2e suite, which runs the whole application on
 * this double. Every property the contract asserts is one an e2e test would
 * otherwise be quietly relying on without anything having checked it.
 */
describeOutboxStoreContract("InMemoryOutboxStore", () => {
  const store = new InMemoryOutboxStore();
  return Promise.resolve({
    store,
    transactions: new InMemoryTransactionRunner(),
    // The same instance: with no connections, two overlapping `drain` calls on
    // one store is the whole of the contention this implementation has.
    other: { store },
  });
});

describe("InMemoryOutboxStore", () => {
  it("starts empty", async () => {
    const store = new InMemoryOutboxStore();

    await expect(store.countByStatus()).resolves.toEqual({ PENDING: 0, PUBLISHED: 0, DEAD: 0 });
  });

  it("dead-letters an event whose name this build does not know", async () => {
    const store = new InMemoryOutboxStore();
    const transactions = new InMemoryTransactionRunner();
    await transactions.run((tx) =>
      store.stage(tx, {
        eventId: "evt-unknown",
        // Reachable only one way: a deploy removed the event from
        // `DomainEventPayloads` while rows staged under it were still pending.
        name: "user.retired" as never,
        payload: {} as never,
        correlationId: null,
        trace: EMPTY_TRACE_CARRIER,
        occurredAt: new Date(0),
      }),
    );

    const deliver = jest.fn();
    const report = await store.drain({
      now: new Date(),
      batchSize: 10,
      deliver,
      retryAt: () => new Date(Date.now() + 1000),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        disposition: "dead",
        error: expect.stringContaining("not in DomainEventPayloads"),
      }),
    ]);
  });
});
