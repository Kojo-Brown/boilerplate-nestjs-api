import type { TransactionContext, TransactionRunner } from "@/common/prisma/transaction.port";

/**
 * A {@link TransactionRunner} with no database behind it.
 *
 * For unit specs of services that open a transaction — `AuthService`,
 * `DeleteUserHandler` — where the collaborators inside it are already doubles and
 * the point of the spec is what the service does, not what Postgres does.
 *
 * It honours the one part of the contract a double can honour: compensations
 * registered with `onRollback` run, in reverse order, when the callback throws.
 * It provides no isolation whatsoever — two concurrent `run` calls interleave
 * freely — so a spec asserting that a transaction *excluded* something is
 * asserting about this class and not about the system. That belongs in
 * `test/outbox-store.db-spec.ts`.
 */
export class InMemoryTransactionRunner implements TransactionRunner {
  /** How many units of work have been opened. Handy for asserting one was. */
  started = 0;
  committed = 0;
  rolledBack = 0;

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.started += 1;
    const compensations: Array<() => void | Promise<void>> = [];
    const tx: TransactionContext = {
      backend: "in-memory",
      onRollback: (undo) => {
        compensations.push(undo);
      },
    };

    try {
      const result = await work(tx);
      this.committed += 1;
      return result;
    } catch (error) {
      this.rolledBack += 1;
      for (const undo of [...compensations].reverse()) await undo();
      throw error;
    }
  }
}
