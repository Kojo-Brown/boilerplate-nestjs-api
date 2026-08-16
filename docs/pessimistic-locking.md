# Pessimistic locking

Optimistic concurrency lets both writers proceed and refuses the one that lost,
with a 412. That is the right trade when conflicts are rare and the client can
re-read and retry.

Sometimes it is not. Some operations cannot be retried — the work between the
read and the write is expensive, or has a side effect, or the "resource" is a
single-use credential that only one caller may be allowed to spend. For those,
a writer needs to **block** rather than fail, and hold the row until it is done.
That is `SELECT … FOR UPDATE` inside an interactive transaction.

|                      | Optimistic (`If-Match`)        | Pessimistic (`FOR UPDATE`)         |
| -------------------- | ------------------------------ | ---------------------------------- |
| Conflict shows up as | 412, on the write              | a wait, before the read            |
| Client must          | re-read and retry              | nothing                            |
| Costs                | a wasted attempt per conflict  | a held lock, and a queue behind it |
| Good for             | edits a human made from a page | claim-once, non-retryable work     |

## The primitive

`src/common/locking` exposes one function:

```ts
const locked = await prisma.$transaction(async (tx) => {
  const locked = await lockRows(tx, {
    table: "refresh_tokens",
    keyColumn: "token",
    keys: [token],
    strength: "update",
    waitTimeoutMs: 3_000,
  });
  // … re-read and write here, still inside the transaction …
});
```

It emits

```sql
SELECT "token" AS "key" FROM "refresh_tokens"
WHERE "token" IN ($1) ORDER BY "token" FOR UPDATE
```

and resolves with the keys it actually locked. Keys with no row are absent from
the result rather than an error, so "did I get it?" is a length check.

### It only works inside a transaction

A row lock is released when the transaction that took it ends. Called on the
top-level client, the statement runs in its own implicit transaction and the
lock is gone before the next line executes — the code looks locked and is not.
`lockRows` takes a `RawQueryExecutor` rather than a `PrismaClient` so that
passing the wrong thing is at least deliberate.

### Lock, then read

Everything read _before_ the lock may already be stale. The sequence is always
lock → re-read → write, all in the same transaction.

Under Postgres' default `READ COMMITTED`, a waiting `FOR UPDATE` re-evaluates
its own `WHERE` once the wait ends. So if the previous holder deleted the row,
the waiter's lock attempt comes back with no rows at all rather than with a row
that no longer exists. That is what makes the return value a usable answer to
"did I win?", and it is pinned by a test rather than taken on trust.

### Strength: the foreign-key trap

Inserting a child row takes `FOR KEY SHARE` on its parent. That conflicts with
`FOR UPDATE` and **not** with `FOR NO KEY UPDATE`.

In this schema `refresh_tokens.userId` references `users.id`, so:

```ts
// Blocks every concurrent login and refresh for this user until we commit.
await lockRows(tx, { table: "users", keyColumn: "id", keys: [id], strength: "update" });

// Same mutual exclusion against other writers, no effect on child inserts.
await lockRows(tx, { table: "users", keyColumn: "id", keys: [id], strength: "no-key-update" });
```

Both statements are asserted against a real server in `test/row-lock.db-spec.ts`.
**Prefer `no-key-update` when locking a row you are not deleting and whose key
columns you are not changing** — which is almost always. Reach for `update` when
the row may be deleted, as the refresh-token store does.

### Waiting

| `wait`           | Behaviour                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait` (default) | Block until the holder commits or rolls back.                                                                                                     |
| `no-wait`        | Fail immediately with `LockUnavailableError`.                                                                                                     |
| `skip-locked`    | Return only the free rows. A queue-draining primitive — never use it to fetch a _specific_ row, because held and absent become indistinguishable. |

Set `waitTimeoutMs` on anything using the default. Without it the ceiling is
Prisma's interactive-transaction timeout, which aborts the waiter with a message
about transactions rather than about locks. Postgres reports both `NOWAIT` and
`lock_timeout` as SQLSTATE `55P03`, differing only in message text, so both
arrive as `LockUnavailableError` — the recourse is the same either way.

### Deadlocks

`lockRows` sorts its keys, and `LockRows` sits above `Sort` in the query plan,
so rows are locked in key order. Two callers locking overlapping sets therefore
agree on the order and cannot deadlock against each other.

That guarantee stops at this function. A `DeadlockDetectedError` (SQLSTATE
`40P01`) means some other lock was taken somewhere in the same transaction, in a
different order — it is a signal to go looking, not something to paper over with
a retry.

## Where it is used: refresh-token rotation

`POST /v1/auth/refresh` spends the presented token and issues a new pair. Only
one caller may spend a given token, so `RefreshTokenStore.consume` is defined to
claim it atomically:

```ts
consume(token: string): Promise<ConsumedRefreshToken | null>;
```

`PrismaRefreshTokenStore` implements it as lock → read → delete in one
transaction. It locks on `token` rather than on the primary key deliberately:
the id is not known until the row is read, so locking by id would need an
unlocked read first — and every caller would race in the gap between them.

This replaced a read-then-delete. Both requests found the row, and only the
`DELETE` separated them, by raising `P2025` on a row the winner had already
removed. Nothing maps that to a status, so **the loser was answered 500** where
the truthful answer is 401. The token was single-use throughout, so this was not
a replay hole — but the property lived in whichever statement happened to be
last rather than anywhere it could be stated or tested, and `deleteMany`
(which `logout` already uses, and which reports a count instead of raising)
would have quietly turned one token into two live families.

Expiry deliberately stays in `AuthService`, not the store: the store decides
_who_ gets the row, and whether the credential is still acceptable is policy.
An expired token is therefore spent on presentation — it is of no use to anyone,
and leaving it behind only means writing a sweeper for rows nobody can claim.

## Testing this

Nothing here can be verified against a fake. Whether `FOR UPDATE` excludes a
second transaction is a property of Postgres, so the suites that assert it need
a real one:

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db
pnpm db:migrate:prod
pnpm test:db
```

`test/*.db-spec.ts` deliberately has no skip-if-absent branch. A lock suite that
passes without a database reports that the database behaves correctly while
never having asked it.

The store is a port for the same reason. `RefreshTokenStore`'s contract lives in
`src/auth/refresh-token-store.contract.ts` and runs twice: against Postgres in
`test/refresh-token-store.db-spec.ts`, and against the in-memory double in
`src/auth/refresh-token-store.contract.spec.ts`. The double serialises claims
through a per-token promise chain so that it satisfies the same exclusion
honestly — within one process, which is why it is a test double and not a
deployable store.

## What this does not do

- **No `@Lock()` decorator or distributed lock.** These locks live in Postgres
  and cover rows in Postgres. Serialising work that is not a database row — a
  cron leader, an external API call — is the Redlock item in `SPEC.md`.
- **No advisory locks.** `pg_advisory_xact_lock` serialises on an arbitrary
  key rather than a row, and is what you want when the thing being protected
  has no row to lock.
- **Nothing but `refresh_tokens` uses it yet.** `lockRows` is table-agnostic;
  the one call site is `PrismaRefreshTokenStore`.
- **No automatic retry on deadlock.** Deliberate: a deadlock here means two
  lock orders exist, and retrying hides that.
