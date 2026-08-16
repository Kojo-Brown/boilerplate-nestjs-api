import { Prisma } from "@prisma/client";
import { DeadlockDetectedError, LockUnavailableError } from "./locking.errors";

/**
 * How strong a lock to take on each row.
 *
 * The two weaker modes are not decoration. Postgres row locks conflict by
 * *pair*, and the pair that catches people out involves foreign keys: inserting
 * a child row takes `FOR KEY SHARE` on its parent, and `FOR KEY SHARE`
 * conflicts with `FOR UPDATE` but not with `FOR NO KEY UPDATE`.
 *
 * Concretely, in this schema, `SELECT … FROM users … FOR UPDATE` blocks every
 * concurrent `INSERT INTO refresh_tokens` for that user — so locking a user row
 * to serialise an edit to its name would also stall every login and refresh for
 * that account until the edit committed. `no-key-update` is the same mutual
 * exclusion against other writers with none of that blast radius, and is the
 * right choice whenever the locked row's *key* columns are not being changed.
 *
 * `update` is still correct — and required — when the row itself may be
 * deleted, which is why the refresh-token store uses it.
 */
export type RowLockStrength = "update" | "no-key-update" | "share" | "key-share";

/** What to do when some other transaction already holds a conflicting lock. */
export type RowLockWaitPolicy =
  /** Block until the holder commits or rolls back. The Postgres default. */
  | "wait"
  /** Fail immediately with {@link LockUnavailableError}. */
  | "no-wait"
  /**
   * Return only the rows that were free, silently omitting the held ones. This
   * is a queue-draining primitive ("give me work nobody else has claimed"), and
   * it is the wrong answer whenever the caller needs a *specific* row: a locked
   * row and an absent row become indistinguishable in the result.
   */
  | "skip-locked";

/**
 * The subset of a Prisma client that `lockRows` needs.
 *
 * Typed as this rather than `Prisma.TransactionClient` so a caller cannot pass
 * the top-level client by accident and have the lock released the moment the
 * statement ends — see the note on {@link lockRows}. It also keeps the helper
 * testable without standing up a client.
 */
export interface RawQueryExecutor {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

export interface RowLockSpec {
  /** Physical table name, as it exists in Postgres — `refresh_tokens`, not `RefreshToken`. */
  readonly table: string;
  /**
   * Physical column the keys are matched against. Must be unique and indexed:
   * an unindexed predicate makes this a sequential scan that locks every row it
   * examines, which is a table lock wearing a row lock's clothes.
   */
  readonly keyColumn: string;
  readonly keys: readonly string[];
  /** Defaults to `update`. See {@link RowLockStrength} before widening it. */
  readonly strength?: RowLockStrength;
  /** Defaults to `wait`. */
  readonly wait?: RowLockWaitPolicy;
  /**
   * Cap on how long to block, in milliseconds, applied with `SET LOCAL
   * lock_timeout`. Ignored unless `wait` is `wait`, since the other two
   * policies never block.
   *
   * Worth setting on any interactive transaction: without it a waiter blocks
   * for as long as the holder runs, and what eventually fires is Prisma's own
   * transaction timeout, which aborts the *waiter* with a message about
   * transactions rather than about locks.
   */
  readonly waitTimeoutMs?: number;
}

const STRENGTH_SQL: Record<RowLockStrength, string> = {
  update: "FOR UPDATE",
  "no-key-update": "FOR NO KEY UPDATE",
  share: "FOR SHARE",
  "key-share": "FOR KEY SHARE",
};

const WAIT_SQL: Record<RowLockWaitPolicy, string> = {
  wait: "",
  "no-wait": " NOWAIT",
  "skip-locked": " SKIP LOCKED",
};

/** Postgres SQLSTATEs this translates. */
const LOCK_NOT_AVAILABLE = "55P03";
const DEADLOCK_DETECTED = "40P01";

/**
 * Unquoted SQL identifiers this helper is willing to emit.
 *
 * Table and column names cannot be bound as parameters, so they are the one
 * part of the statement that is interpolated. Every caller in this repository
 * passes a literal, but "no caller passes user input *today*" is not a property
 * a security review can check by reading this file — so the allowlist is
 * enforced here, where the string becomes SQL.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(kind: string, name: string): Prisma.Sql {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe ${kind} identifier for a row lock: ${JSON.stringify(name)}`);
  }
  return Prisma.raw(`"${name}"`);
}

/**
 * Takes row locks on `keys` and resolves with the keys actually locked.
 *
 * **Must be called with an interactive-transaction client.** A row lock lives
 * until the transaction that took it ends; `prisma.$queryRaw` outside a
 * transaction runs in its own implicit one, so the lock is taken and released
 * by the same statement and guards nothing at all. `RawQueryExecutor` narrows
 * the parameter so the mistake is at least deliberate.
 *
 * The pattern this exists for is lock-then-read: everything read *before* the
 * lock may already be stale, so a caller must re-read inside the transaction
 * and decide from that. Under Postgres' default `READ COMMITTED`, the locking
 * `SELECT` re-evaluates its own `WHERE` against the committed row once the wait
 * ends, so a key whose row the previous holder deleted simply does not come
 * back — which is what makes "did I win?" answerable from the return value.
 *
 * Returned keys are sorted, and the underlying statement sorts too. That is not
 * cosmetic: `LockRows` sits above `Sort` in the plan, so rows are locked in key
 * order, and two callers locking overlapping sets therefore take them in the
 * same order and cannot deadlock against each other. Locking a set in the order
 * an unsorted scan happened to return it is the classic way to earn a `40P01`
 * under load and not be able to reproduce it.
 *
 * A key with no matching row is not an error and is simply absent from the
 * result; a caller that requires every key to exist should compare lengths.
 */
export async function lockRows(tx: RawQueryExecutor, spec: RowLockSpec): Promise<string[]> {
  // `IN ()` is a syntax error, and there is nothing to lock anyway.
  if (spec.keys.length === 0) return [];

  const table = quoteIdentifier("table", spec.table);
  const column = quoteIdentifier("column", spec.keyColumn);
  const strength = Prisma.raw(STRENGTH_SQL[spec.strength ?? "update"]);
  const waitPolicy = spec.wait ?? "wait";
  const wait = Prisma.raw(WAIT_SQL[waitPolicy]);

  try {
    if (waitPolicy === "wait" && spec.waitTimeoutMs !== undefined) {
      await tx.$executeRaw(applyLockTimeout(spec.waitTimeoutMs));
    }

    // Deduplicated: `IN` would happily take a key twice, and the second copy is
    // pure overhead in a statement whose length is bounded by the caller.
    const keys = [...new Set(spec.keys)];
    const rows = await tx.$queryRaw<{ key: string }[]>(
      Prisma.sql`SELECT ${column} AS "key" FROM ${table} WHERE ${column} IN (${Prisma.join(keys)}) ORDER BY ${column} ${strength}${wait}`,
    );
    return rows.map((row) => row.key);
  } catch (error) {
    throw translateLockError(error, spec);
  }
}

/**
 * `SET LOCAL lock_timeout`, which applies for the rest of the transaction.
 *
 * `SET` takes no bind parameters, so the value is interpolated — hence the
 * range check. `LOCAL` matters: without it the setting would leak to whatever
 * the connection pool hands this connection to next, and a stray 250 ms lock
 * timeout on an unrelated request is a very hard bug to find.
 */
function applyLockTimeout(ms: number): Prisma.Sql {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error(`waitTimeoutMs must be a non-negative integer, got ${String(ms)}`);
  }
  return Prisma.sql`SET LOCAL lock_timeout = ${Prisma.raw(`'${ms}ms'`)}`;
}

/**
 * Maps Postgres' lock SQLSTATEs onto this module's errors.
 *
 * Prisma reports every raw-query failure as `P2010` regardless of cause, so the
 * SQLSTATE is the only thing that distinguishes contention from a typo in a
 * table name. It arrives in two places depending on the driver adapter in use,
 * and both are checked: `meta.driverAdapterError.cause.code`, and the rendered
 * message, which embeds it as "Code: `55P03`". Neither is documented API — the
 * fallback exists because relying on one shape of an internal object is how
 * this silently starts classifying every deadlock as a 500 after an upgrade.
 * Anything unrecognised is rethrown untouched.
 */
function translateLockError(error: unknown, spec: RowLockSpec): unknown {
  const sqlState = extractSqlState(error);
  if (sqlState === LOCK_NOT_AVAILABLE) {
    return new LockUnavailableError(spec.table, spec.keys, { cause: error });
  }
  if (sqlState === DEADLOCK_DETECTED) {
    return new DeadlockDetectedError(spec.table, { cause: error });
  }
  return error;
}

function extractSqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const meta = (error as { meta?: unknown }).meta;
  const fromMeta = readPath(meta, ["driverAdapterError", "cause", "code"]);
  if (typeof fromMeta === "string") return fromMeta;

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const match = /Code: `([A-Za-z0-9]+)`/.exec(message);
    if (match) return match[1];
  }
  return undefined;
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
