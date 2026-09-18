# Batching a hot relation, and catching the N+1 that made it hot

An N+1 is the read path asking the database once for a list and then once more
per row on it. It is not a slow query — every statement in it is fast, which is
why it survives a code review, a load test on one record and a p50 latency
graph. What it is, is a read count that moves with the size of the result: a
page of twenty orders costs twenty-one round trips, a page of a hundred costs a
hundred and one, and the endpoint gets slower in production for a reason no
single query explains.

This repository had one, in the place they usually are: a list endpoint joining
each row to something the row only names.

```ts
// src/orders/read/list-orders.query.ts, before
const views = await Promise.all(
  rows.map(async (order) => toOrderView(order, await this.sagas.find(order.sagaId), this.registry)),
);
```

Two things fix it and only one of them is right here.

**Denormalising** the fulfilment onto the `orders` row removes the second read
entirely, and `src/orders/read/order-view.ts` explains why the table
deliberately has no `paymentId` column: the saga writes its state on every step,
an order column would be written by whichever step remembered to, and the two
copies drift. A customer would then be shown a payment id the orchestrator
disagrees with.

**Batching** keeps one copy of the fact and reads it once per page. That is what
`SagaStore.findMany` and `SagaLoaders` are.

## The loader

[`DataLoader`](https://github.com/graphql/dataloader) collects every key asked
for within a tick and calls the batch function once with all of them.
`src/common/dataloader/entity-loader.ts` wraps it, because two details of that
contract are easy to get wrong and both fail silently:

- **Results are matched to keys by position.** The batch function must return
  exactly one entry per key, in the order the keys were given. A repository
  batch read does not work that way — `findMany` returns the rows that exist, in
  whatever order the planner chose — so passing `store.findMany` straight to
  `new DataLoader()` pairs entities with the wrong keys the moment one row is
  missing or the planner reorders two. `createEntityLoader` indexes the result
  by key and rebuilds the array.
- **An `Error` in that array is a rejection for its key.** That is the
  documented way to say "no such entity", and it is wrong for a relation that is
  legitimately optional: an order whose saga instance has been pruned would fail
  the whole page rather than render with an empty fulfilment. Misses resolve
  `null`.

The call site keeps its shape:

```ts
// after
const sagas = this.loaders.byId();
const views = await Promise.all(
  rows.map(async (order) => toOrderView(order, await sagas.load(order.sagaId), this.registry)),
);
```

The `await` inside the `map` is what makes it read like an N+1 and is not one:
every `load` is queued in the same tick and the loader turns the page into a
single `findMany`. The alternative — collect the ids, read them, zip the results
back — is the same two statements written so that a second relation cannot be
read alongside the first without a third pass.

## Why the loader is made per operation, not injected

A `DataLoader` is a batching window and a cache in one object, and the cache is
what decides its lifetime. `SagaLoaders` is a singleton that makes loaders;
nothing injects a loader.

Nest offers `Scope.REQUEST` for exactly this, and `docs/di-scopes.md` says why
it is the wrong reach here: the scope propagates up the injection graph, so a
request-scoped loader would make `ListOrdersHandler` request-scoped too, and
`QueryBus` resolves its handlers once at bootstrap. Creating the loader inside
`execute` gets the batching with no scope at all, and gives the cache the only
lifetime that is certainly safe — shorter than the request.

The lifetime is not a performance question. A loader held on a singleton would
answer with rows read before the write that changed them, and would hand one
caller's saga to the next caller that names the same id. A page of orders is one
customer's, so a shared cache there is a cross-account read rather than a stale
render. Within one operation the cache is worth having and on by default: two
orders placed in the same checkout name the same saga, and the second must not
queue a second key for it.

## Catching it in a test

A batched read is only batched until somebody writes the obvious `await` inside
a loop again, and nothing about the response says which it was. Both halves of
`src/test-utils/n-plus-one.ts` count reads rather than time them, and both run
the operation at several result sizes, because growth is the signal:

```ts
const growth = await measureQueryGrowth({
  sizes: [1, 2, 20],
  recorders: [orders.recorder, sagas.recorder],
  run: async (size) => {
    await seed(size);
    await list(size);
  },
});

expect(growth.countsBySize).toEqual({ 1: 2, 2: 2, 20: 2 });
```

- `recordCalls` proxies a repository port and records every method called on it.
  A proxy rather than a spy per port, so that a handler which starts calling
  something else is still counted. This runs in
  `src/orders/read/list-orders.query.spec.ts`, on doubles, in milliseconds.
- `test/helpers/prisma-query-probe.ts` does the same with a Prisma client
  extension, counting what actually reached the database.
  `test/orders-read.db-spec.ts` runs the real handler over real Postgres and
  asserts two statements — `Order.findMany`, `SagaInstance.findMany` — at page
  sizes 1, 20 and 100.

Neither replaces the other. A port whose `findMany` looped internally would pass
the first and fail the second; the second needs a database and runs in the `db`
suite only. The probe is an extension rather than a reader of Prisma's query
log because the log is an event stream with its own timing, and a spec reading
it has to guess how long to wait for events that may still be arriving.

Assert the exact counts, not only `growth.constant`. A second batched read added
later is still constant, and is still a decision worth making on purpose.

## What is not batched

`GetOrderQuery` reads one order and one saga, which is two statements and has no
batch to make. The users, audit-log and outbox read paths have no per-row
relation at all: `GET /v1/users` returns rows from one table, and the audit log
deliberately does not join the actor — `audit_log.actorId` is not a foreign key,
because an entry outlives the account it describes.

So there is one loader, for the one relation that was hot. The apparatus is
worth having for the next one; inventing loaders for relations nobody reads per
row is how a codebase acquires a caching layer nobody can reason about.

`maxBatchSize` is unset on the saga loader: a page is capped at 100 by
`CursorPaginationDto`, which is nothing for an `IN` list. A loader over an
unbounded set should set one rather than discover the driver's parameter limit
in production.
