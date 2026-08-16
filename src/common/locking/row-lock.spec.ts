import { Prisma } from "@prisma/client";
import { lockRows } from "./row-lock";
import type { RawQueryExecutor } from "./row-lock";
import { DeadlockDetectedError, LockUnavailableError } from "./locking.errors";

/**
 * Records the statements `lockRows` builds without running them.
 *
 * `Prisma.Sql` exposes `sql` (the text, with `$1`-style placeholders) and
 * `values` separately, which is exactly what has to be asserted: that keys
 * arrive as bound parameters and only the allowlisted identifiers and clauses
 * are ever interpolated.
 *
 * The SQL itself is not exercised here — `test/row-lock.db-spec.ts` runs it
 * against a real Postgres, because whether `FOR UPDATE` actually excludes a
 * second transaction is not a question a fake can answer.
 */
function recorder(rows: { key: string }[] = [], failWith?: unknown) {
  const queries: Prisma.Sql[] = [];
  const executed: Prisma.Sql[] = [];
  const tx: RawQueryExecutor = {
    $queryRaw: <T>(query: Prisma.Sql): Promise<T> => {
      queries.push(query);
      if (failWith !== undefined) return Promise.reject(failWith);
      return Promise.resolve(rows as T);
    },
    $executeRaw: (query: Prisma.Sql): Promise<number> => {
      executed.push(query);
      return Promise.resolve(0);
    },
  };
  return { tx, queries, executed };
}

/** The error shape Prisma 7 raises for a failed raw query through a driver adapter. */
function prismaRawError(sqlState: string, message = "boom") {
  return Object.assign(
    new Error(`Raw query failed. Code: \`${sqlState}\`. Message: \`${message}\``),
    {
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { kind: "postgres", code: sqlState, message },
        },
      },
    },
  );
}

describe("lockRows", () => {
  describe("statement construction", () => {
    it("binds the keys as parameters rather than inlining them", async () => {
      const { tx, queries } = recorder([{ key: "a" }]);

      await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["a", "b"] });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.values).toEqual(["a", "b"]);
      expect(queries[0]!.sql).not.toContain("a");
    });

    it("quotes the table and column and selects the key back", async () => {
      const { tx, queries } = recorder();

      await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["a"] });

      expect(queries[0]!.sql).toContain(`FROM "refresh_tokens"`);
      expect(queries[0]!.sql).toContain(`SELECT "token" AS "key"`);
    });

    it("orders by the key column so overlapping callers lock in the same order", async () => {
      const { tx, queries } = recorder();

      await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["b", "a"] });

      expect(queries[0]!.sql).toContain(`ORDER BY "token"`);
    });

    it("defaults to FOR UPDATE with no wait clause", async () => {
      const { tx, queries } = recorder();

      await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["a"] });

      expect(queries[0]!.sql).toContain("FOR UPDATE");
      expect(queries[0]!.sql).not.toContain("NOWAIT");
      expect(queries[0]!.sql).not.toContain("SKIP LOCKED");
    });

    it.each([
      ["update", "FOR UPDATE"],
      ["no-key-update", "FOR NO KEY UPDATE"],
      ["share", "FOR SHARE"],
      ["key-share", "FOR KEY SHARE"],
    ] as const)("emits %s as %s", async (strength, expected) => {
      const { tx, queries } = recorder();

      await lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"], strength });

      expect(queries[0]!.sql).toContain(expected);
    });

    it.each([
      ["no-wait", "NOWAIT"],
      ["skip-locked", "SKIP LOCKED"],
    ] as const)("emits %s as %s", async (wait, expected) => {
      const { tx, queries } = recorder();

      await lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"], wait });

      expect(queries[0]!.sql).toContain(expected);
    });

    it("deduplicates keys", async () => {
      const { tx, queries } = recorder();

      await lockRows(tx, { table: "t", keyColumn: "k", keys: ["a", "a", "b"] });

      expect(queries[0]!.values).toEqual(["a", "b"]);
    });

    it("issues no statement at all for an empty key list", async () => {
      // `IN ()` does not parse, and there is nothing to lock.
      const { tx, queries, executed } = recorder();

      await expect(lockRows(tx, { table: "t", keyColumn: "k", keys: [] })).resolves.toEqual([]);
      expect(queries).toHaveLength(0);
      expect(executed).toHaveLength(0);
    });
  });

  describe("lock timeout", () => {
    it("sets lock_timeout LOCAL, before the locking statement", async () => {
      const { tx, executed, queries } = recorder();

      await lockRows(tx, {
        table: "t",
        keyColumn: "k",
        keys: ["a"],
        waitTimeoutMs: 250,
      });

      expect(executed).toHaveLength(1);
      // LOCAL is what keeps the setting from leaking to the next request that
      // is handed this pooled connection.
      expect(executed[0]!.sql).toBe("SET LOCAL lock_timeout = '250ms'");
      expect(queries).toHaveLength(1);
    });

    it.each(["no-wait", "skip-locked"] as const)(
      "does not set a timeout for %s, which never blocks",
      async (wait) => {
        const { tx, executed } = recorder();

        await lockRows(tx, {
          table: "t",
          keyColumn: "k",
          keys: ["a"],
          wait,
          waitTimeoutMs: 250,
        });

        expect(executed).toHaveLength(0);
      },
    );

    it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      "rejects %p, which would be interpolated into SQL",
      async (ms) => {
        const { tx } = recorder();

        await expect(
          lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"], waitTimeoutMs: ms }),
        ).rejects.toThrow("waitTimeoutMs");
      },
    );
  });

  describe("identifier safety", () => {
    it.each([`t" ; DROP TABLE users; --`, "t t", "1t", "", "públic", "t;"])(
      "refuses the table name %p",
      async (table) => {
        const { tx, queries } = recorder();

        await expect(lockRows(tx, { table, keyColumn: "k", keys: ["a"] })).rejects.toThrow(
          /Unsafe table identifier/,
        );
        expect(queries).toHaveLength(0);
      },
    );

    it("refuses an unsafe column name", async () => {
      const { tx } = recorder();

      await expect(
        lockRows(tx, { table: "t", keyColumn: `k" , (SELECT 1) AS "x`, keys: ["a"] }),
      ).rejects.toThrow(/Unsafe column identifier/);
    });
  });

  describe("results", () => {
    it("resolves with the keys that were locked", async () => {
      const { tx } = recorder([{ key: "a" }, { key: "b" }]);

      await expect(lockRows(tx, { table: "t", keyColumn: "k", keys: ["a", "b"] })).resolves.toEqual(
        ["a", "b"],
      );
    });

    it("omits keys with no matching row rather than failing", async () => {
      const { tx } = recorder([{ key: "a" }]);

      await expect(
        lockRows(tx, { table: "t", keyColumn: "k", keys: ["a", "missing"] }),
      ).resolves.toEqual(["a"]);
    });
  });

  describe("error translation", () => {
    it("maps 55P03 to LockUnavailableError, carrying the requested keys", async () => {
      const { tx } = recorder([], prismaRawError("55P03", "could not obtain lock on row"));

      const error = await lockRows(tx, {
        table: "refresh_tokens",
        keyColumn: "token",
        keys: ["a"],
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LockUnavailableError);
      expect((error as LockUnavailableError).table).toBe("refresh_tokens");
      expect((error as LockUnavailableError).keys).toEqual(["a"]);
    });

    it("maps a lock_timeout cancellation to LockUnavailableError too", async () => {
      // Postgres reports NOWAIT and lock_timeout with the same SQLSTATE and
      // differs only in the message; the caller's recourse is the same.
      const { tx } = recorder(
        [],
        prismaRawError("55P03", "canceling statement due to lock timeout"),
      );

      await expect(
        lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"] }),
      ).rejects.toBeInstanceOf(LockUnavailableError);
    });

    it("maps 40P01 to DeadlockDetectedError", async () => {
      const { tx } = recorder([], prismaRawError("40P01", "deadlock detected"));

      await expect(
        lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"] }),
      ).rejects.toBeInstanceOf(DeadlockDetectedError);
    });

    it("reads the SQLSTATE from the message when the meta shape is absent", async () => {
      // The `meta` object is adapter internals; the rendered message is what
      // Prisma itself formats. Neither is documented API, so both are tried.
      const fromMessageOnly = Object.assign(
        new Error("Raw query failed. Code: `40P01`. Message: `deadlock detected`"),
        { code: "P2010" },
      );
      const { tx } = recorder([], fromMessageOnly);

      await expect(
        lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"] }),
      ).rejects.toBeInstanceOf(DeadlockDetectedError);
    });

    it("preserves the driver error as the cause", async () => {
      const original = prismaRawError("55P03");
      const { tx } = recorder([], original);

      const error = await lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"] }).catch(
        (e: unknown) => e,
      );

      expect((error as Error).cause).toBe(original);
    });

    it("rethrows an unrelated failure untouched", async () => {
      const original = prismaRawError("42P01", `relation "nope" does not exist`);
      const { tx } = recorder([], original);

      await expect(lockRows(tx, { table: "nope", keyColumn: "k", keys: ["a"] })).rejects.toBe(
        original,
      );
    });

    it("rethrows a non-object rejection untouched", async () => {
      const { tx } = recorder([], "just a string");

      await expect(lockRows(tx, { table: "t", keyColumn: "k", keys: ["a"] })).rejects.toBe(
        "just a string",
      );
    });
  });
});
