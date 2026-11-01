# Integration testing

`pnpm test:integration` runs the suites in `test/integration/` against real
servers that the suite starts for itself: one `postgres:17-alpine`, migrated
from nothing, and three independent `redis:8-alpine` nodes. It needs a Docker
socket and nothing else — no service to start by hand, no `DATABASE_URL` to
set, no `.env`.

```
pnpm install
pnpm db:generate
pnpm test:integration
```

In CI it is the `Integration (Testcontainers)` job, which blocks a merge like
every other gate.

## The four tiers, and which one a new test belongs in

| Script                  | Config                       | Backed by                        | Use it for                                                                                   |
| ----------------------- | ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`             | `jest.config.ts`             | in-memory doubles                | Everything that can be decided without a server. The coverage threshold is here.             |
| `pnpm test:e2e`         | `test/jest-e2e.json`         | in-memory doubles, full Nest app | HTTP-level behaviour: status codes, headers, guards, validation.                             |
| `pnpm test:db`          | `test/jest-db.json`          | a Postgres **you** provide       | Postgres semantics, against a server from `docker compose up -d postgres` or the CI service. |
| `pnpm test:integration` | `test/jest-integration.json` | containers the suite starts      | Anything that needs a real server _and_ should not need anybody to arrange one.              |

A new suite goes in the integration tier when both halves of that last sentence
are true. If an in-memory double can decide it, it belongs in `pnpm test`,
which runs in forty seconds and is where the coverage gate lives.

## Why containers rather than services in the workflow

The `test` job already attaches Postgres and three Redis nodes as GitHub Actions
`services`, and for what that job uses them for it is the cheaper mechanism.
It is the wrong one for a test suite, for three reasons that are all about
where the knowledge lives.

**A service block is a fact about the workflow, not about the code.** Nothing in
the repository says the `*.db-spec.ts` suites need a server, so a clean clone
either talks to whatever is listening on 5432 — which on a working machine is a
development database with data in it — or fails with a connection error that
names no cause. The Redis case is worse than that, because it is silent: with
`REDIS_URL` unset, the real-Redis legs of `idempotency-store.contract.spec.ts`
and `distributed-lock.contract.spec.ts` collapse to `it.todo` and the run
passes green having checked a `Map`. Four tests were pending on every local run
before this tier existed, and nothing about the output said the Redis half of
two contracts had not been exercised.

**A service block fixes the server version away from the assertions that depend
on it.** `POSTGRES_IMAGE` and `REDIS_IMAGE` in `test/integration/containers.ts`
sit next to the suites that care.

**And a service cannot be stopped.** It runs for the length of the job. The most
important property Redlock has is that a majority keeps working when a minority
has gone away, and that no lock is issued when no majority is left — and with a
service container the only way to express "this node is gone" is a stand-in.
`distributed-lock.contract.spec.ts` uses `FakeRedisNode` with `down = true` for
exactly that reason. `test/integration/distributed-lock.integration-spec.ts`
stops a real container instead.

## What the containers hand over

`globalSetup` sets the application's own environment variables rather than a
parallel set invented for tests, so the tier configures the code the way a
deployment does and `test/helpers/db.ts` works against it unchanged:

- `DATABASE_URL` — the migrated application database
- `REDIS_URL` — the first Redis node
- `REDLOCK_NODES` — all three, comma-separated

Read them through `integrationDatabaseUrl()`, `integrationRedisUrl()` and
`integrationRedisUrls()` from `test/integration/containers.ts`. Those throw a
sentence naming the cause when the variable is unset, which is what a file run
under the wrong Jest config gets instead of `connect ECONNREFUSED ::1:5432`
forty lines into a stack trace.

## Three things that will bite

**Give a new suite its own Redis database.** Add a field to
`REDIS_TEST_DATABASES` in `src/test-utils/redis-test-databases.ts` and read it
from there. Every suite here resets with `FLUSHDB`, which knows nothing about
key prefixes, so two suites sharing a database delete each other's keys. A
duplicate is a deterministic failure in `redis-test-databases.spec.ts`; a
comment claiming which databases are free is not.

**A client pointed at a stopped node needs `retryStrategy: () => null`.**
Without it ioredis keeps a reconnect timer alive for a server that is never
coming back, the worker does not exit, and Jest reports it as leaking. With it,
a command to a dead node rejects at once — which is also what Redlock needs,
since a node that does not answer must be a missing vote rather than a stall.

**Do not stop a container `globalSetup` started.** The three Redis nodes and the
Postgres are a shared fixture, and a node stopped out from under them is missing
for every file that runs afterwards. A suite that needs to take a server away
starts its own, as the `losing a node for real` block does; three
`redis:8-alpine` containers start in about a second between them.

## The migration history is a subject here, not a precondition

`globalSetup` runs `prisma migrate deploy` against a database that began the run
empty, and `test/integration/schema.integration-spec.ts` then asserts what it
built:

- every committed migration applied, in order, with none left half-finished —
  read out of `_prisma_migrations`, which is the only place a partially applied
  step is recorded;
- the result matches `prisma/schema.prisma` exactly, via
  `prisma migrate diff --exit-code`. This is the drift check: a column added to
  the schema and to no migration types a field in the generated client that the
  database does not have, which `pnpm typecheck` cannot see and the first query
  selecting it fails on.

Prisma models tables, columns, indexes and constraints. The row-level security
policies and the `require_tenant_id()` function that
`20261002000000_add_multi_tenancy` installs are outside that model and so are
invisible to the diff — `test/tenant-isolation.db-spec.ts` is what asserts
those, by making the database refuse a query.

## Cost

About 40 seconds in CI, most of it pulling images on a cold cache. Four
containers for the shared fixture plus three more for the node-loss block;
`redis:8-alpine` is some 15 MB and starts in well under a second.

If `pnpm test:integration` cannot reach a Docker socket it fails rather than
skipping, which is deliberate: a tier whose whole purpose is to stop a missing
server from being invisible must not go quiet when the server is missing.
