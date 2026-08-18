# Distributed locking

`docs/pessimistic-locking.md` covers the lock you should reach for first: a row
lock inside a Postgres transaction. It is held by the database that owns the
data, it is released when the transaction ends whatever happens to the client,
and it costs nothing to operate.

This document is about the case where that is not available — work that is not a
row. A nightly reconciliation that must run on one replica, a third-party API
that must not be called twice, a file that must be rebuilt by one worker. There
is no row to lock, so the lock has to live somewhere both replicas can see, and
"somewhere" here is Redis.

|                  | Postgres row lock      | Redlock                             |
| ---------------- | ---------------------- | ----------------------------------- |
| Guards           | rows                   | anything with a name                |
| Released by      | the transaction ending | a TTL, or the holder                |
| A crashed holder | releases immediately   | blocks until the lease expires      |
| Safety rests on  | the database           | a lease **and** a fencing token     |
| Costs            | a queue behind the row | a round trip to a majority of nodes |

## The honest version of what this buys you

Redlock takes the same key on N independent Redis masters and considers itself
the holder once a majority answered within the lease. Losing a minority of nodes
loses no acknowledged lock, which is what a single primary with replicas cannot
promise: replication is asynchronous, so a lock acknowledged and not yet
replicated is simply absent from the replica that gets promoted.

What it cannot do — and no lease-based lock can — is make a _stopped process_
notice it has been stopped. A holder paused past its TTL by a long GC, a
suspended VM, or a network black hole resumes still believing it holds the lock,
by which time its successor is running. Martin Kleppmann's critique of Redlock is
right about this, and the answer is not to argue with it:

> **The lease keeps two callers from overlapping most of the time. The fencing
> token is what keeps the overlap from corrupting anything.**

Every acquisition here carries a `fencingToken` — a number that strictly
increases with every successful acquisition, anywhere in the service. The
resource being written must reject any write carrying a token below the highest
one it has already accepted. Then a stalled holder that wakes up late is refused
by the resource itself, whatever it believes about the lock.

```ts
// The fenced write: the predicate is in the UPDATE, so there is no window
// between checking the token and using it.
await prisma.order.updateMany({
  where: { id, fencingToken: { lt: lock.fencingToken } },
  data: { status: "captured", fencingToken: lock.fencingToken },
});
```

Where the resource cannot do that — a filesystem, most third-party APIs — the
lock is an _optimisation_ that stops most duplicate work, and the operation
underneath it still has to be idempotent. Say so in the call site's comment
rather than assuming the lock is enough.

## Using it

### `@Lock()` on a provider method

```ts
@Injectable()
export class ReportsService {
  @Lock({ key: ([month]) => `reports:${month as string}`, ttlMs: 30_000, waitMs: 5_000 })
  async rebuild(month: string): Promise<Report> {
    const fence = currentLock()!.fencingToken;
    ...
  }
}
```

- The key defaults to `lock:<Class>.<method>:<arguments>`, which is usually
  either too coarse or too fine — pass `key` whenever an argument that does not
  identify the resource takes part in it.
- `waitMs` defaults to `0`: contention throws immediately. Raise it where the
  caller can afford to queue.
- The lease is renewed for as long as the method runs (`renew: false` to switch
  that off, `maxHoldMs` to bound it).
- `currentLock()` reads the handle from the async context, so the method's
  signature does not change.

### `withLock()` everywhere else

`@Lock()` is installed by `AspectWeaver` at `onModuleInit`, which reaches
singleton providers only — a controller handler is already bound to the router
by then, and request-scoped providers do not exist yet. Applying it to either is
a **boot failure**, not a warning: every other aspect degrades into an absence,
while a lock that is not installed leaves a method running without the exclusion
it was written to assume.

In a controller, a BullMQ processor, or a script, call the helper directly. It
is the same code the decorator runs:

```ts
await withLock(lock, `orders:${id}`, { ttlMs: 30_000, waitMs: 5_000 }, async (held) => {
  ...
});
```

### What it throws

| Error                  | When                                                      | Sensible HTTP mapping |
| ---------------------- | --------------------------------------------------------- | --------------------- |
| `LockNotAcquiredError` | somebody holds it, or no quorum answered, within `waitMs` | 409, or 503           |
| `LockLostError`        | the lease lapsed while the method was still running       | 500 — and investigate |

Both are plain `Error`s rather than `HttpException`s, like the row-lock errors:
the same contention reached over a queue consumer or a CLI is not a "409". Map
them where the operation is exposed:

```ts
try {
  return await this.reports.rebuild(month);
} catch (error) {
  if (error instanceof LockNotAcquiredError) {
    throw new ConflictException("That report is already being rebuilt.");
  }
  throw error;
}
```

`LockLostError` is raised **even when the method returned a value**. That is
deliberate: the result was produced by a caller that had stopped being the
holder, so it may be the product of a race. Nothing here can retract what the
method already did — this is a report, not a rollback, and it is why the fencing
token matters.

## Configuration

```bash
DISTRIBUTED_LOCK=redlock
REDLOCK_NODES=redis://redis-a:6379,redis://redis-b:6379,redis://redis-c:6379
```

- `DISTRIBUTED_LOCK=memory` is the default so a clean clone boots with nothing
  configured, and it is **refused in production**: a `Map` is not shared between
  replicas, so the second replica takes every lock the first one holds, silently.
- The nodes must be **independent masters**. Nodes that replicate to each other
  are not a quorum, they are one node with copies.
- Fewer than three nodes logs a warning at boot. It is allowed — one node is a
  reasonable development setup — but it is a single point of failure, and a node
  that restarts empty grants keys it had already granted.

## How the algorithm is implemented here

Per acquisition, in order:

1. **Claim.** `SET <key> <random value> PX <ttl> NX` on every node, in parallel.
   The value is 16 CSPRNG bytes and is what makes release and extend safe.
2. **Draw a token.** The same Lua script runs `INCR` on the node's fencing
   counter, so a node cannot hand out a token for a lock it did not grant. The
   issued token is the highest returned by the quorum.
3. **Check the clock.** `validity = ttl − elapsed − drift`, where elapsed is
   measured on a _monotonic_ clock (`performance.now()`, never `Date.now()`,
   which NTP can step backwards) and drift is `1% of the ttl + 2ms`. A quorum
   assembled more slowly than the lease lasts is not a lock, and is released.
4. **Publish the token.** The token is written back to every node's counter
   (never lowering it) and a majority must confirm. This is what makes the
   tokens _monotonic_ rather than merely large: a node that refused an
   acquisition never ran `INCR` for it, so its counter lags, and a later quorum
   made of laggards would otherwise issue a token already in use.
5. **Fail closed.** Anything short of a quorum, at either step, releases
   everywhere and answers "not acquired" — including on the nodes whose answers
   arrived too late to count, because a command that timed out may still have
   been applied.

Release and extend are Lua compare-and-act scripts: they touch the key only if
it still carries this holder's value. A bare `DEL` is the classic bug — a holder
whose lease lapsed mid-operation deletes its successor's lock, and a third
caller walks in.

### Fencing counters

One counter per node (`redlock:fence`), shared by every key, with no TTL. A
token only has to exceed every token issued before it, so one sequence for the
whole service is enough, and it keeps the counter's key count at one per node.
Per-key counters would have to expire, and an expiring counter restarts at 1 —
which a resource that has already accepted token 5,000 refuses forever.

The monotonicity argument rests on two assumptions worth naming:

- **A node does not lose its counter.** A node that restarts from an empty
  dataset comes back with a counter of 0. That is a liveness failure rather than
  a safety one — the resource refuses the low tokens that follow — but it needs
  an operator. Run the nodes with persistence on, and rebuild a lost node from a
  snapshot rather than from nothing.
- **A majority is a majority.** Two disjoint quorums cannot exist, which is what
  makes the published token visible to every later acquisition. Adding or
  removing nodes changes what a majority is, so change the node list one node at
  a time, with a pause long enough for every outstanding lease to expire.

## Testing

`distributed-lock.contract.ts` is one behavioural contract run against every
implementation: the in-memory lock, Redlock on a single node, Redlock on three,
and Redlock on three with one down. The Redis legs run against real
`redis-server` processes — CI starts three `redis:8-alpine` services — because
every property that matters (`SET NX` settling a race, `PX` expiring a lease, a
script running without interleaving) is a Redis guarantee that a mock would
merely imitate.

`redlock.service.spec.ts` covers what a real server will not do on request:
counters that have drifted apart, a node that accepted the connection and went
quiet, a round trip that outlives the lease.

To run the quorum legs locally:

```bash
for port in 6379 6380 6381; do redis-server --port $port --daemonize yes; done
REDLOCK_NODES=redis://127.0.0.1:6379,redis://127.0.0.1:6380,redis://127.0.0.1:6381 pnpm test
```

Without `REDLOCK_NODES` or `REDIS_URL` those legs are reported as pending rather
than quietly passing.

## What is not here

- **No lock queue.** Waiting is polling with jittered backoff, not a fair queue:
  callers are not served in the order they arrived. Redis has no primitive that
  gives fairness across independent nodes without becoming a consensus system.
- **No re-entrancy.** A method holding `k` that calls another method locking `k`
  deadlocks against itself until the wait budget runs out. Lock at one level.
- **No lock inventory.** There is no "who holds what" endpoint. `redis-cli
--scan --pattern 'redlock:lock:*'` against each node is the answer, and it is
  a snapshot of one node's opinion.
- **Nothing is wired to it yet.** Like `@Cacheable()` and `@Retry()`, `@Lock()`
  ships as a facility with its tests and this document; no production call site
  in this repository takes a distributed lock today. The transactional-outbox
  relay in Phase 9 is the first one that will want one.
