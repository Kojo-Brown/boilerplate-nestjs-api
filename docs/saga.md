# Saga orchestration

A business operation that spans several services is run as an ordered list of
steps, each one locally atomic, with an explicit undo for the ones that can be
undone. When a step fails, the list is run backwards.

```ts
// The whole checkout, as the code states it.
defineSaga<CheckoutSagaState>("order.checkout", [
  { name: "accept-order", kind: "compensatable", execute, compensate }, // → CANCELLED
  { name: "reserve-stock", kind: "compensatable", execute, compensate }, // → release
  { name: "charge-payment", kind: "compensatable", execute, compensate }, // → refund
  { name: "create-shipment", kind: "pivot", execute }, // no way back
  { name: "confirm-order", kind: "retriable", execute }, // must succeed
]);
```

| Piece                 | Role                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `defineSaga`          | Builds a definition and refuses an incoherent one at boot        |
| `SagaRegistry`        | Name → definition, so a row can be resumed by a poller           |
| `SagaOrchestrator`    | Runs one step, writes what happened, decides what is next        |
| `SAGA_STORE`          | Persistence: `create` joins a transaction, `claim` takes a lease |
| `SagaRecoveryService` | The poller that advances sagas nothing is driving                |
| `CheckoutSaga`        | The one definition that ships, in `src/orders`                   |

Everything below is the reasoning behind the parts that are not obvious.

---

## The problem, stated exactly

There is no transaction that spans a payment gateway and a database.

That sentence is the whole design. `docs/outbox.md` solves the two-writes
problem _within_ one service by making the second write part of the first
commit; a checkout cannot use it, because the second write is a POST to Stripe.
Two-phase commit would be the textbook answer and is not available: neither
Stripe, nor a warehouse API, nor a carrier exposes a prepare/commit protocol,
and a coordinator that held locks across all of them would make a slow
participant into an outage for everyone else.

What is left is to give up atomicity and buy back the useful half of it:
**every step is locally atomic, and every step that can be undone has an undo.**
A saga is not a transaction. It has no isolation at all — a partly-completed
checkout is visible to everybody while it runs — and its "rollback" is a
sequence of new operations rather than the absence of old ones. A refund is not
the inverse of a charge; the customer saw both.

## Orchestration, not choreography

Two ways to run a saga. In **choreography**, each service listens for the
previous one's event and publishes its own; there is no coordinator. In
**orchestration**, one component holds the order of the steps and calls each
participant.

This repository orchestrates, and the reason is legibility. The order of a
checkout is a business rule someone has to be able to read, argue about and
change — and in a choreography that rule does not exist anywhere. It is the
union of five subscribers in five modules, and answering "what happens if the
card is declined?" means reading all five and simulating them in your head.
`checkout.saga.ts` answers it in twelve lines.

What that costs is a coupling point: the orchestrator knows about every
participant. It is paid for by keeping the _engine_ ignorant of them —
`src/saga` contains no mention of orders, payments or stock. It takes
definitions from a registry and state as JSON.

Choreography is the better answer when the steps genuinely belong to
independent teams who must be able to add a reaction without asking anybody. It
is the worse one when the sequence itself is the product.

## The three kinds of step

The kinds are Garcia-Molina and Salem's structure, as Chris Richardson states
it, and they are not decoration — the orchestrator reads them to decide whether
a failure may be rolled back:

- **`compensatable`** — undoable, so a later failure can unwind it. The type
  refuses one without a `compensate`.
- **`pivot`** — the go/no-go point. If it fails the saga compensates; once it
  succeeds the saga is committed. At most one, and everything before it must be
  compensatable.
- **`retriable`** — after the pivot. Guaranteed to succeed _eventually_, because
  there is no longer any other option.

`defineSaga` enforces the shape `compensatable* pivot? retriable*` at
construction, so a definition that promises to unwind something past the point
of no return fails the boot rather than the first order.

**Why the shipment is the pivot.** `ShippingService` has no `cancelShipment`,
because a carrier that has the parcel cannot be told the sale is off. A return
is a new process with its own cost, not the inverse of a dispatch. Everything
before it — the hold, the charge — can be given back.

**Why payment comes before shipping, and stock before payment.** Releasing a
hold is free and refunding is not: a customer who sees a charge and a refund on
their statement has had a worse time than one who was told the item was gone,
even though the system ends in the same state. And nothing may be dispatched
before the money is in, because a parcel cannot be recalled.

## At-least-once, and what it demands

The orchestrator writes a step's outcome **after** the step returns, in a
transaction of its own, because the step's work was a call to another service
and there is no transaction that spans both. A crash in that window re-runs the
step on recovery.

So every participant must be idempotent, and the orchestrator makes that
possible rather than merely asking for it: each step is handed
`context.idempotencyKey`, `<sagaId>:<step name>`, stable across every attempt of
one step and distinct between steps.

How each participant uses it is worth reading, because the three cases are
different:

- **Inventory and shipping** take the key _as the id of the thing they create_.
  That is `PUT` semantics rather than `POST`, and it closes a gap a server-
  assigned id cannot: a reserve whose response was lost leaves a hold the caller
  has no id for, so "release whatever I reserved" becomes a request the client
  cannot express — the stock stays committed to a cancelled order and nothing
  in the system knows.
- **Payments** cannot do that: the gateway issues its own ids. It is idempotent
  on `reference` instead, which the step sets to the key. The compensation
  therefore has a harder job, and `resolvePayment` does something that looks
  wrong until you follow it through — if `state.paymentId` is null it calls
  `authorize` _again_ to turn the reference back into an id. It returns the
  payment that already exists rather than creating a second one. The cost is
  that a step which failed before authorising leaves an authorisation nobody
  captures, which lapses at the provider; the alternative is silently keeping
  money. A gateway with search-by-reference would not need the trade.
- **The order row** is written under a status guard. `accept-order` moves only a
  `PENDING` order, and `confirm-order` returns early for one already
  `CONFIRMED` — so a re-run writes nothing and, crucially, stages no second
  `order.confirmed`.

Compensations get the same key and the same rules, plus one more: **a
compensation runs for the step that failed, too.** A step that threw may still
have half-executed, and asking is the only way to find out. So every
`compensate` has to tolerate there being nothing to undo.

## Why a lease, where the outbox holds a lock

`OutboxStore.drain` holds its transaction open across the broker publish, and
`docs/outbox.md` defends that: the publish is bounded by a timeout measured in
seconds, and a relay that dies mid-batch simply never commits.

A saga cannot copy it. A step is an arbitrary call to another service with no
bound the database knows about, and parking a Postgres connection on somebody
else's network for the duration is how a slow dependency becomes a failing API.
So a claim is a **lease**: `lockedBy` plus `lockedUntil`, written by a single
`UPDATE … WHERE … RETURNING`.

The cost of a lease is that it can expire while its holder is still working, so
`lockedBy` is a fencing token — every write back to the row is conditional on
it, and a runner whose lease has moved on gets `null` from `save` and stops
quietly. That is not an error path; it is two replicas doing the ordinary thing.

The one configuration that breaks this is a lease shorter than the step it
covers, so `env.schema.ts` refuses to boot unless `SAGA_LEASE_MS` is more than
twice `SAGA_STEP_TIMEOUT_MS`. Set it the other way and every slow step runs
twice, concurrently — a double charge under a setting that reads as though it
were merely impatient.

Note what the step timeout does and does not do: it bounds the orchestrator's
_wait_, not the step. JavaScript has no cancellation, so a call that eventually
answers does so into a promise nobody is listening to, while its side effect at
the other service happened anyway.

## Failure: transient, permanent, and past the pivot

A step throws to fail. A plain error is transient and goes on a full-jitter
ladder (`src/common/backoff`, shared with the outbox relay and the Kafka
consumer). `UnretryableStepError` is permanent and turns the saga around
immediately — spending six attempts to prove that a shelf is still empty only
delays telling the customer. The split is the same one `DomainEventConsumer`
makes between a handler failure and an undecodable message.

Which way the saga may then go is decided by the failing step's kind:

| Where it failed        | What happens                               |
| ---------------------- | ------------------------------------------ |
| Before or at the pivot | Compensate backwards, ending `COMPENSATED` |
| After the pivot        | Retry; on exhaustion, `STUCK`              |
| A compensation itself  | Retry; on exhaustion, `STUCK`              |

`STUCK` is the status worth alerting on, and it is deliberately not dressed up
as anything else. Every stuck saga is money or stock in a state the system
decided against and could not undo. Reporting a failed compensation as
`COMPENSATED` would be a lie, and continuing past it would unwind the steps
_before_ something that is still in place.

## The cursor, and why renaming a step is a migration

The row stores a _position_ — `cursor` counts up going forward and down going
back, so one column carries both directions. That means a deploy which inserts,
removes or reorders a step changes what every running instance's cursor means:
a saga that had charged a card would resume into whatever now sits at index 2
and compensate a payment by releasing stock.

The log records names, so the two can be checked. `assertResumable` requires
that the i-th step an instance completed going forward is still the i-th step of
the definition, and marks the instance `STUCK` when it is not. Renaming a step
is therefore a data migration, and the check makes that consequence loud rather
than theoretical.

## Durability

Nothing about this is durable without the poller. `PlaceOrderHandler` advances
the saga inside the request that placed the order — which is why an ordinary
checkout answers with a finished order rather than a job id — but that call is
an optimisation. If the process dies before it, during it, or between two of its
steps, the row is still there, due, and unleased; `SagaRecoveryService` claims
it on the next poll and carries on from the step the row says it reached.

With `SAGA_RECOVERY_ENABLED=false` on every replica, a saga interrupted between
two steps stays where it stopped. The service logs a warning at boot saying so.

## What this is still not

- **No parallel steps.** The list is sequential. A checkout that could reserve
  stock and check fraud at the same time cannot say so, and adding it means a
  cursor that is a set rather than a number.
- **No timeouts on the saga as a whole.** Individual steps are bounded; a saga
  that spends a day on a ladder is not.
- **No redrive.** A `STUCK` instance needs a human and there is no endpoint to
  reset one — it is a database write today.
- **No history retention.** Terminal instances stay in the table forever. The
  poller's index keeps it off the hot path, but nothing prunes.
- **The read path is N+1.** `ListOrdersQuery` fetches one saga per order, so a
  page of twenty is twenty-one round trips. `SagaStore` has no batch read; the
  fix when a page of orders becomes hot is one, not denormalising the fulfilment
  onto the order row.
- **Inventory and shipping are in-process.** They are ports with working
  in-memory implementations — real state machines, not stubs, in the way
  `MockPaymentProvider` is. In a deployment they are somebody else's HTTP API
  and `orders.module.ts` is the only file that changes.
- **A redirect-based gateway does not fit.** `charge-payment` fails permanently
  on `requires_action`, because 3-D Secure needs the buyer and a saga step has
  nobody to redirect. That flow needs a step that _waits_ for a webhook, which
  is a different shape than this repository has.

## Running it

```
POST /v1/orders   { "items": [{ "sku": "SKU-DESK-01", "quantity": 2 }], "shippingCountry": "GB" }
GET  /v1/orders/{id}
GET  /v1/orders?limit=20&cursor=…
```

A checkout answers **201 either way**. A failed one is an order with
`status: "CANCELLED"` and a `failureReason`, not a 4xx: the row exists, it is
addressable, and an error response would be claiming that nothing was created.
The only 4xx from `POST` is a request that was never an order — an unknown SKU,
an invalid country, no items.

`fulfilment` on the response is the machinery's view next to the customer's. A
`CANCELLED` order whose saga is `COMPENSATED` was cleanly unwound. A
`PROCESSING` order whose saga is `STUCK` is the one somebody needs to know
about.

Two failures are reachable from a request against the shipped catalogue, which
is what `test/orders.e2e-spec.ts` uses rather than injecting faults:
`SKU-SOLD-OUT` fails at `reserve-stock`, and any `shippingCountry` outside
`SERVICED_COUNTRIES` — `AQ`, say — fails at the pivot and takes the saga all the
way back through a refund and a release.

## Testing

- `saga-store.contract.ts` is one behavioural contract run against both stores:
  the double in `saga-store.contract.spec.ts`, Postgres in
  `test/saga-store.db-spec.ts`. The properties that matter are about exclusion —
  that a claim is atomic and that a stale runner's write is refused — and the
  double cannot evidence them: its claim is atomic because nothing in it awaits,
  which is a property of the event loop rather than of the code.
- `saga-orchestrator.service.spec.ts` covers the state machine against trivial
  steps: ladders, compensation order, the pivot skip, fencing, and a definition
  that changed under a running instance.
- `checkout.saga.spec.ts` runs the real five steps against the real warehouse,
  carrier and mock gateway. Nothing there is a spy, because what it is about is
  what happens _between_ those services when one says no.
- The crash that matters — a step that ran and whose progress write was lost —
  is produced by `loseLastWrite`, since the orchestrator's whole job is to never
  produce it.
