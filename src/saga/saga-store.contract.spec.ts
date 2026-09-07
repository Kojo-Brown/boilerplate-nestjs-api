import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { describeSagaStoreContract } from "./saga-store.contract";

/**
 * The double, held to the same contract as the Postgres adapter.
 *
 * Both halves matter and neither is sufficient. This one runs in milliseconds
 * on every push and catches a double that has drifted from the interface the
 * e2e suite runs the whole application against; `test/saga-store.db-spec.ts`
 * runs the identical cases against a real server, where the claim's atomicity
 * is a property of `UPDATE … RETURNING` rather than of the event loop.
 */
describeSagaStoreContract("InMemorySagaStore", async () => {
  const store = new InMemorySagaStore();
  return {
    store,
    transactions: new InMemoryTransactionRunner(),
    // No connections here, so the "second runner" is the same instance — which
    // is exactly the contention a `Map` has.
    other: { store },
  };
});
