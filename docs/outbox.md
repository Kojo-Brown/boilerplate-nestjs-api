# The transactional outbox

A domain event is written to the database in the same transaction as the data it
describes, and a relay publishes it afterwards.

```ts
// Publisher — the row and the event commit together or not at all.
await this.transactions.run(async (tx) => {
  const user = await this.users.create({ email, password: hash }, tx);
  await this.outbox.stage(tx, "user.registered", { userId: user.id, email, ... });
  return user;
});

// Subscriber — unchanged. It is still an @OnDomainEvent method.
```

| Piece                 | Role                                                       |
| --------------------- | ---------------------------------------------------------- |
| `TRANSACTION_RUNNER`  | Opens the unit of work and hands out an opaque handle      |
| `TransactionalOutbox` | `stage(tx, name, payload)` — the publisher-facing API      |
| `OUTBOX_STORE`        | Persistence: `stage` joins a transaction, `drain` owns one |
| `OUTBOX_PUBLISHER`    | The broker seam. `DomainEventBusPublisher` today           |
| `OutboxRelayService`  | The poller: claim → publish → mark, with backoff           |

Everything below is the reasoning behind the parts that are not obvious.

---

## What it buys, precisely

[events.md](./events.md) ends with three limits of a bare emitter. Two of them
are what this closes:

- **A publish is lost if the process dies.** It is now a row, committed before
  anyone reacts.
- **An event can describe something that did not happen.** `publish` used to be
  called from inside a service method, so an event emitted before a later
  statement threw described an operation that rolled back. Staging inside the
  transaction makes that impossible: the event and the write share a commit.

The third — that nothing reaches another replica — is **not** closed, because
the publisher that ships is the in-process bus. See "What this is still not".

## Why staging has to take the caller's transaction

An outbox row written on its own connection is not an outbox. It is a second
thing that can fail on its own, and it fails in both directions: the data
commits and the event does not, or the event commits and the data does not. The
whole mechanism is one commit carrying both, which is why `OutboxStore.stage`
takes a `TransactionContext` and never opens one.

That is also why `UserWriter.create` grew an optional trailing `tx`. Without it
the insert runs on a pooled connection of its own and commits independently of
the event staged beside it — which looks identical in the code and is not
atomic at all.

`AuthService.register` hashes the password _outside_ the transaction, and there
is a spec pinning that. argon2 is deliberately slow; holding a connection and
the transaction's locks for the length of a KDF would make every registration a
multi-hundred-millisecond writer.

## Why the relay holds its transaction across the publish

The claim is:

```sql
SELECT … FROM "outbox_events"
 WHERE "status" = 'PENDING' AND "nextAttemptAt" <= $1
 ORDER BY "occurredAt", "id"
 LIMIT $2
   FOR UPDATE SKIP LOCKED
```

and the transaction stays open while each claimed row is published.

`FOR UPDATE` is what stops two relays publishing the same row. `SKIP LOCKED` is
what stops the second relay _blocking_ on the first one's batch for the whole of
its broker round trip — without it, scaling out to more replicas buys nothing.

Holding the transaction across broker I/O is the part that looks wrong and is
deliberate. The alternative is a lease: mark the rows claimed, commit, publish
outside the transaction, mark them published. That avoids a long transaction,
but the lease has to be expired by a clock somebody has to be right about, and a
relay that dies mid-publish leaves rows claimed until it lapses. Holding the
lock has no such knob: the process dies, the connection drops, Postgres releases
the locks, and the rows are simply due again. The cost is bounded on two sides —
`OUTBOX_BATCH_SIZE` caps how many rows one relay can make invisible at once, and
`OUTBOX_PUBLISH_TIMEOUT_MS` caps how long a broker that has stopped answering
can hold them.

Take the lease approach instead when the broker is slow enough that a batch
routinely outlives `DRAIN_TIMEOUT_MS` (30s in `prisma-outbox.store.ts`).

## Delivery is at-least-once

Three ways the same event is delivered twice:

1. the publish succeeds and the transaction then fails to commit;
2. the publish succeeds but does not answer within
   `OUTBOX_PUBLISH_TIMEOUT_MS`, so the relay records a failure and retries;
3. any crash between the broker accepting the event and the row being marked.

There is no configuration that removes these. Committing the mark in the same
transaction as the publish would require the broker to be in that transaction,
which is the distributed-transaction problem the outbox exists to avoid.

So **consumers must be idempotent**, and `DomainEvent.id` is the handle they
deduplicate on. It is minted when the row is staged and is reused on every
redelivery — which is why `PublishContext` grew an `eventId`: a relay that let
the bus mint a fresh `randomUUID()` per attempt would make every retry look like
a new event, and the id would be worthless for exactly the job it exists to do.

## Ordering

A single relay delivers in `occurredAt` order, because the claim says so.

That does **not** survive concurrent relays, and it is not meant to. Two
replicas claim disjoint batches under `SKIP LOCKED` and publish them
independently, so `user.deleted` staged after `user.registered` can be delivered
before it. Nor does it survive a retry: a failed event comes back after its
backoff, by which time later events have gone out.

Per-aggregate ordering would need a partition key on the row and a claim that
takes at most one in-flight event per key. Nothing here needs it — a welcome
email and an account cleanup are independent — so it is not built. Do not assume
an order the claim does not provide.

## The retry ladder

Full jitter: `random(0, min(max, base · 2^n))`, in `outbox-backoff.ts`.

Plain exponential backoff is wrong here for a reason specific to a relay. A
broker outage fails every claimed row within a few milliseconds of the others, so
a deterministic ladder schedules all of them for the same instant — and the
recovery attempt arrives as a thundering herd against a broker that has just come
back. Full jitter spreads them across the whole window.

After `OUTBOX_MAX_ATTEMPTS` the row goes `DEAD` with its last error. It is not
retried again; a human is expected to look. `countByStatus()` is what a health
check or dashboard reads.

## What can and cannot be validated on the way out

`name` is checked against `DOMAIN_EVENT_NAMES` before a record is built, because
it is the discriminant: an unrecognised name must not reach a subscriber typed
for a different payload. A row naming an event this build does not have is
dead-lettered rather than retried — a later deploy is not going to grow the
event back, and a relay that kept re-reading it would make no progress on that
row forever. That case is reachable exactly one way: a deploy removed an entry
from `DomainEventPayloads` while rows staged under it were still pending.

The **payload is not validated**. There is no runtime schema for these payloads
anywhere in the repository — the catalogue is types only — so validating here
would mean inventing a second source of truth that can drift from the first.
What that leaves uncovered is a row written by an older build whose payload
shape has since changed: it will be handed to a subscriber typed for the new
shape. Adding a Zod schema per event, derived from or checked against the
catalogue, is what would close it.

## What this is still not

- **Not fan-out — unless `OUTBOX_PUBLISHER=broker`.** The default,
  `DomainEventBusPublisher`, delivers to the in-process bus, so subscribers run
  on the replica whose relay won the row: durability and retries, but no
  delivery to another service. `BrokerOutboxPublisher` produces to Kafka
  instead and every consumer group over the topic gets a copy. It binds to
  `OUTBOX_PUBLISHER` and nothing in the relay changed when it did, exactly as
  this section predicted — see `docs/messaging.md`.
- **Not per-handler retry.** "Delivered" means "every subscriber handled it", so
  one failing handler retries the whole event and the handlers that already
  succeeded run again. That is another reason subscribers have to be idempotent.
  Producing to a broker does not fix it either: `DomainEventConsumer` publishes
  the whole event to the bus on the far side and withholds the commit if any
  subscriber failed, so the fan-out is across _services_, not across handlers
  within one. Splitting handlers into their own consumer groups is what would
  give each its own retry, and nothing does that today.
- **Not change-data capture.** Polling costs a query per replica per tick
  whether or not anything is due, and adds up to `OUTBOX_POLL_INTERVAL_MS` of
  latency. Reading the WAL (Debezium and similar) removes both, at the cost of
  an operational dependency this repository does not have.
- **Not swept.** `PUBLISHED` rows accumulate. A production deployment wants a
  periodic delete of rows published more than N days ago; nothing here does it.

## Running it

`OUTBOX_RELAY_ENABLED` is on by default — an outbox nobody drains is a queue
that only grows. Running the relay on every API replica is the intended shape;
`SKIP LOCKED` is what makes that safe. Turn it off for a topology that relays
from a dedicated worker, and for tests, which drive `runOnce()` themselves
rather than racing a timer.

The e2e suite does exactly that: `TestApp.drainOutbox()` runs one pass. A spec
asserting on a background effect has to drain first, and that is not scaffolding
hiding a problem — it is the latency the outbox trades for durability, made
explicit rather than slept through.

## Testing

| Suite                           | What it can prove                                      |
| ------------------------------- | ------------------------------------------------------ |
| `outbox-store.contract.ts`      | The behaviour both implementations must share          |
| `outbox-store.contract.spec.ts` | …against the in-memory double the e2e suite runs on    |
| `test/outbox-store.db-spec.ts`  | …against Postgres: real `ROLLBACK`, real `SKIP LOCKED` |
| `outbox-relay.service.spec.ts`  | The ladder, the timeout, the timer, shutdown           |
| `outbox-backoff.spec.ts`        | The jitter window, exactly                             |

The split matters. The two properties the pattern rests on — that a staged event
disappears with its transaction, and that a claimed row is invisible to another
relay — are properties of Postgres. Asserted only against the double they would
be properties of a `Map`; asserted only against Postgres, nothing would stop the
double the e2e suite runs the whole application on from breaking both.
