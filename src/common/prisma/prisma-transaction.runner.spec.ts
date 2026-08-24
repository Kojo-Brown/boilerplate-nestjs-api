import type { PrismaService } from "./prisma.service";
import {
  PrismaTransactionRunner,
  isPrismaTransaction,
  requirePrismaTransaction,
} from "./prisma-transaction.runner";
import type { TransactionContext } from "./transaction.port";

/** A `$transaction` that hands the callback a marker and reports how it ended. */
function fakePrisma() {
  const client = { marker: "the-transaction-client" };
  const calls: { options: unknown }[] = [];
  let outcome: "committed" | "rolled-back" | null = null;

  const prisma = {
    $transaction: async <T>(work: (c: unknown) => Promise<T>, options: unknown): Promise<T> => {
      calls.push({ options });
      try {
        const result = await work(client);
        outcome = "committed";
        return result;
      } catch (error) {
        outcome = "rolled-back";
        throw error;
      }
    },
  } as unknown as PrismaService;

  return { prisma, client, calls, ended: () => outcome };
}

describe("PrismaTransactionRunner", () => {
  it("resolves with whatever the unit of work returned", async () => {
    const { prisma } = fakePrisma();

    await expect(new PrismaTransactionRunner(prisma).run(() => Promise.resolve(42))).resolves.toBe(
      42,
    );
  });

  it("hands the callback the interactive-transaction client", async () => {
    const { prisma, client } = fakePrisma();

    const seen = await new PrismaTransactionRunner(prisma).run((tx) =>
      Promise.resolve(requirePrismaTransaction(tx, "spec")),
    );

    expect(seen).toBe(client);
  });

  /**
   * Prisma's own defaults are 5s and 2s and would be inherited silently. The
   * callback holds every row it has touched for its whole duration, so what the
   * number means is "how long one writer may block every other writer" — a
   * decision, not a default.
   */
  it("states its timeouts rather than inheriting them", async () => {
    const { prisma, calls } = fakePrisma();

    await new PrismaTransactionRunner(prisma).run(() => Promise.resolve());

    expect(calls[0]?.options).toEqual({ timeout: 5_000, maxWait: 2_000 });
  });

  it("rolls back when the unit of work throws, and rethrows what it threw", async () => {
    const { prisma, ended } = fakePrisma();

    await expect(
      new PrismaTransactionRunner(prisma).run(() => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
    expect(ended()).toBe("rolled-back");
  });

  describe("compensations", () => {
    it("does not run them when the unit of work succeeds", async () => {
      const { prisma } = fakePrisma();
      const undo = jest.fn();

      await new PrismaTransactionRunner(prisma).run((tx) => {
        tx.onRollback(undo);
        return Promise.resolve();
      });

      expect(undo).not.toHaveBeenCalled();
    });

    it("runs them in reverse order when it fails", async () => {
      const { prisma } = fakePrisma();
      const order: string[] = [];

      await expect(
        new PrismaTransactionRunner(prisma).run((tx) => {
          tx.onRollback(() => {
            order.push("first");
          });
          tx.onRollback(() => {
            order.push("second");
          });
          return Promise.reject(new Error("boom"));
        }),
      ).rejects.toThrow("boom");

      // Reverse, because a later participant may depend on what an earlier one
      // did — undoing in registration order can undo the ground from under it.
      expect(order).toEqual(["second", "first"]);
    });

    it("awaits an asynchronous compensation", async () => {
      const { prisma } = fakePrisma();
      let finished = false;

      await expect(
        new PrismaTransactionRunner(prisma).run((tx) => {
          tx.onRollback(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            finished = true;
          });
          return Promise.reject(new Error("boom"));
        }),
      ).rejects.toThrow("boom");

      expect(finished).toBe(true);
    });

    /**
     * A compensation that throws is a bug in a participant. Letting it
     * propagate would replace the error the caller needs — why the transaction
     * failed — with a secondary one from the cleanup, and would strand every
     * compensation after it.
     */
    it("does not let a failing compensation mask the original error", async () => {
      const { prisma } = fakePrisma();
      const later = jest.fn();

      await expect(
        new PrismaTransactionRunner(prisma).run((tx) => {
          tx.onRollback(later);
          tx.onRollback(() => {
            throw new Error("cleanup itself failed");
          });
          return Promise.reject(new Error("the real problem"));
        }),
      ).rejects.toThrow("the real problem");

      expect(later).toHaveBeenCalled();
    });
  });
});

describe("requirePrismaTransaction", () => {
  const foreign: TransactionContext = { backend: "in-memory", onRollback: () => {} };

  it("recognises a handle this runner produced", () => {
    expect(isPrismaTransaction(foreign)).toBe(false);
  });

  /**
   * The alternative is a cast, which turns a handle from another backend into
   * `undefined.outboxEvent` at the first property access — an error that says
   * nothing about the actual mistake.
   */
  it("refuses a handle from another backend, naming both sides", () => {
    expect(() => requirePrismaTransaction(foreign, "PrismaOutboxStore")).toThrow(
      /PrismaOutboxStore was given a "in-memory" transaction/,
    );
  });
});
