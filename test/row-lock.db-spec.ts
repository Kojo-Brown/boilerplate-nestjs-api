import type { PrismaClient } from "@prisma/client";
import { DeadlockDetectedError, LockUnavailableError, lockRows } from "@/common/locking";
import { createClient, truncateAll, uniqueEmail } from "./helpers/db";

/**
 * The Postgres behaviour `lockRows` is built on, pinned against a real server.
 *
 * Every claim in `row-lock.ts`'s comments is asserted here rather than
 * believed: that a lock excludes a second transaction, that the two weaker
 * modes differ in exactly the way that matters for foreign keys, that a waiter
 * re-checks its predicate after the wait, and that `NOWAIT` and `lock_timeout`
 * both surface as `LockUnavailableError`. `src/common/locking/row-lock.spec.ts`
 * covers the statement building; none of it can cover this.
 */
describe("lockRows (Postgres)", () => {
  let client: PrismaClient;
  let other: PrismaClient;

  /** Resolves once `hold` has the lock; call `release` to end its transaction. */
  function holdLock(
    on: PrismaClient,
    keys: string[],
    strength: "update" | "no-key-update" = "update",
  ) {
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const done = on.$transaction(
      async (tx) => {
        await lockRows(tx, {
          table: "refresh_tokens",
          keyColumn: "token",
          keys,
          strength,
        });
        acquired();
        await held;
      },
      { timeout: 20_000 },
    );
    return { ready, release, done };
  }

  async function seedToken(token: string): Promise<string> {
    const user = await client.user.create({ data: { email: uniqueEmail("lock") } });
    await client.refreshToken.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return user.id;
  }

  beforeAll(() => {
    // Two clients, so two transactions can genuinely contend. Two
    // `$transaction` calls on one client may share a pooled connection and
    // would then serialise for a reason that has nothing to do with locking.
    client = createClient();
    other = createClient();
  });

  afterAll(async () => {
    await truncateAll(client);
    await client.$disconnect();
    await other.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  it("returns only the keys that exist", async () => {
    await seedToken("present");

    const locked = await client.$transaction((tx) =>
      lockRows(tx, {
        table: "refresh_tokens",
        keyColumn: "token",
        keys: ["present", "absent"],
      }),
    );

    expect(locked).toEqual(["present"]);
  });

  it("returns keys in sorted order, which is also the order they are locked in", async () => {
    await seedToken("aaa");
    await seedToken("bbb");
    await seedToken("ccc");

    const locked = await client.$transaction((tx) =>
      lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["ccc", "aaa", "bbb"] }),
    );

    // `LockRows` sits above `Sort` in the plan, so the sort decides lock order.
    // Two callers locking overlapping sets therefore agree on the order and
    // cannot deadlock against each other.
    expect(locked).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("fails fast with no-wait while another transaction holds the row", async () => {
    await seedToken("contended");
    const holder = holdLock(client, ["contended"]);
    await holder.ready;

    const attempt = other.$transaction((tx) =>
      lockRows(tx, {
        table: "refresh_tokens",
        keyColumn: "token",
        keys: ["contended"],
        wait: "no-wait",
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(LockUnavailableError);
    holder.release();
    await holder.done;
  });

  it("gives up after waitTimeoutMs rather than blocking indefinitely", async () => {
    await seedToken("slow");
    const holder = holdLock(client, ["slow"]);
    await holder.ready;

    const started = Date.now();
    const attempt = other.$transaction((tx) =>
      lockRows(tx, {
        table: "refresh_tokens",
        keyColumn: "token",
        keys: ["slow"],
        waitTimeoutMs: 300,
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(LockUnavailableError);
    // It waited rather than failing instantly — this is the timeout firing, not
    // NOWAIT. Postgres reports both as 55P03, so the elapsed time is what tells
    // them apart.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    holder.release();
    await holder.done;
  });

  it("omits held rows under skip-locked instead of waiting", async () => {
    await seedToken("taken");
    await seedToken("free");
    const holder = holdLock(client, ["taken"]);
    await holder.ready;

    const locked = await other.$transaction((tx) =>
      lockRows(tx, {
        table: "refresh_tokens",
        keyColumn: "token",
        keys: ["taken", "free"],
        wait: "skip-locked",
      }),
    );

    expect(locked).toEqual(["free"]);
    holder.release();
    await holder.done;
  });

  it("re-checks the predicate after waiting, so a deleted row does not come back", async () => {
    // This is what makes "did I win?" answerable from the return value under
    // READ COMMITTED, and so what makes `consume` correct: the loser's locking
    // SELECT re-evaluates its own WHERE once the wait ends and simply finds
    // nothing, rather than returning a row the winner has already deleted.
    //
    // The delete happens inside the holder's transaction — which is also how
    // `consume` does it. Deleting from outside would queue behind the very lock
    // being demonstrated.
    await seedToken("doomed");

    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = client.$transaction(
      async (tx) => {
        await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["doomed"] });
        await tx.refreshToken.deleteMany({ where: { token: "doomed" } });
        acquired();
        await held;
      },
      { timeout: 20_000 },
    );
    await ready;

    const waiter = other.$transaction(
      (tx) => lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["doomed"] }),
      { timeout: 20_000 },
    );
    // Let the waiter reach the lock and block on it before the holder commits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await holder;

    await expect(waiter).resolves.toEqual([]);
  });

  it("blocks a conflicting lock until the holder commits", async () => {
    await seedToken("serialised");
    const holder = holdLock(client, ["serialised"]);
    await holder.ready;

    let acquired = false;
    const waiter = other
      .$transaction(
        (tx) => lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: ["serialised"] }),
        { timeout: 20_000 },
      )
      .then((locked) => {
        acquired = true;
        return locked;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(acquired).toBe(false);

    holder.release();
    await holder.done;
    await expect(waiter).resolves.toEqual(["serialised"]);
  });

  describe("lock strength and foreign keys", () => {
    /**
     * The reason `RowLockStrength` is a choice rather than a constant.
     *
     * Inserting a child row takes `FOR KEY SHARE` on its parent. That conflicts
     * with `FOR UPDATE` and not with `FOR NO KEY UPDATE` — so locking a user
     * row with the stronger mode also stalls every concurrent login for that
     * account, which is a production incident nobody would predict from
     * reading the code that took the lock.
     */
    async function insertChildWhileParentLocked(
      strength: "update" | "no-key-update",
    ): Promise<boolean> {
      const user = await client.user.create({ data: { email: uniqueEmail("fk") } });

      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const holder = client.$transaction(
        async (tx) => {
          await lockRows(tx, { table: "users", keyColumn: "id", keys: [user.id], strength });
          acquired();
          await held;
        },
        { timeout: 20_000 },
      );
      await ready;

      let inserted = false;
      const insert = other.refreshToken
        .create({
          data: {
            token: `child-${strength}`,
            userId: user.id,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        })
        .then(() => {
          inserted = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 400));
      const blocked = !inserted;

      release();
      await holder;
      await insert;
      return blocked;
    }

    it("FOR UPDATE on a user row blocks inserting one of its refresh tokens", async () => {
      await expect(insertChildWhileParentLocked("update")).resolves.toBe(true);
    });

    it("FOR NO KEY UPDATE on the same row does not", async () => {
      await expect(insertChildWhileParentLocked("no-key-update")).resolves.toBe(false);
    });
  });

  it("raises DeadlockDetectedError when locks are taken in conflicting orders", async () => {
    // `lockRows` sorts, so two of its callers cannot deadlock against each
    // other. Two *separate* calls in opposite orders can, which is what this
    // arranges — and it is the case the error class exists to name.
    await seedToken("lock-a");
    await seedToken("lock-b");

    const lockThen = (on: PrismaClient, first: string, second: string, gate: Promise<void>) =>
      on.$transaction(
        async (tx) => {
          await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: [first] });
          await gate;
          await lockRows(tx, { table: "refresh_tokens", keyColumn: "token", keys: [second] });
        },
        { timeout: 20_000 },
      );

    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const left = lockThen(client, "lock-a", "lock-b", gate).catch((error: unknown) => error);
    const right = lockThen(other, "lock-b", "lock-a", gate).catch((error: unknown) => error);
    // Let both take their first lock before either reaches for the second.
    await new Promise((resolve) => setTimeout(resolve, 250));
    open();

    const outcomes = await Promise.all([left, right]);
    const victims = outcomes.filter((outcome) => outcome instanceof DeadlockDetectedError);
    // Postgres kills exactly one of the pair and lets the other through.
    expect(victims).toHaveLength(1);
  });
});
