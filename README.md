# boilerplate-nestjs-api.

> NestJS 11 · TypeScript 6 · Prisma 7 · PostgreSQL · JWT · OAuth 2.0 · Argon2 · Swagger

Production-grade REST API starter with auth, validation, and DevOps wired up.

## Stack

| Layer         | Tech                                | Version |
| ------------- | ----------------------------------- | ------- |
| Framework     | NestJS                              | 11.1    |
| Language      | TypeScript                          | 6.0     |
| ORM           | Prisma                              | 7.8     |
| Database      | PostgreSQL                          | 17      |
| Auth          | JWT + OAuth 2.0 (Passport)          |         |
| Hashing       | Argon2                              | 0.43    |
| Validation    | class-validator + class-transformer |         |
| Rate limiting | @nestjs/throttler                   |         |
| Testing       | Jest + Supertest                    |         |

## Supported Node versions

`^22.12.0 || ^24.0.0` — the maintained LTS lines, intersected with what Prisma 7
supports. `.npmrc` sets `engine-strict`, so `pnpm install` fails outright on any
other runtime, and CI runs lint, type check, and the full test suite on **both**
versions. Node 22 is the deploy target (the Dockerfile ships `node:22-alpine`);
Node 24 is covered so the next LTS upgrade is a non-event.

CI treats warnings as failures: ESLint runs with `--max-warnings 0`, peer
mismatches fail the install (`strict-peer-dependencies`), and Node runtime
deprecation warnings are thrown via `NODE_OPTIONS=--throw-deprecation`.

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-nestjs-api.git
cd boilerplate-nestjs-api
pnpm install

# Start Postgres + Redis
docker-compose up postgres redis -d

cp .env.example .env   # fill in JWT_SECRET and DATABASE_URL

pnpm db:generate
pnpm db:migrate
pnpm dev               # http://localhost:4000/v1
```

## API Endpoints

```
POST /v1/auth/register   → { accessToken, refreshToken, expiresIn }
POST /v1/auth/login      → { accessToken, refreshToken, expiresIn }
POST /v1/auth/refresh    → { accessToken, refreshToken, expiresIn }
GET  /v1/users/:id       → User
```

## Project Structure

```
src/
├── auth/           # JWT + OAuth 2.0 auth (service, controller, strategies)
├── users/          # Users CRUD
│   └── ports/      # UserReader / UserWriter / UserPreferencesStore + DI tokens
├── payments/       # PaymentProviderFactory → Stripe / PayPal / mock
│   ├── ports/      # PaymentProvider + PAYMENT_PROVIDERS token
│   └── providers/  # One adapter per gateway, held to a shared contract
├── notifications/  # NotificationDispatcher → email / SMS / push, per user preference
│   ├── ports/      # NotificationChannel + NOTIFICATION_CHANNELS token
│   └── channels/   # One adapter per transport, held to a shared contract
├── common/
│   ├── aspects/    # @Cacheable(), @Retry(), @Timed() + the weaver that applies them
│   │   └── ports/  # Clock, randomness, cache and metrics-recorder tokens
│   ├── decorators/ # @Roles(), @CurrentUser()
│   ├── filters/    # AllExceptionsFilter → structured JSON errors
│   ├── guards/     # JwtAuthGuard, RolesGuard
│   ├── http/       # Shared fetch plumbing for third-party JSON APIs
│   ├── pipes/      # Custom validation pipes
│   └── prisma/     # Global PrismaModule + PrismaService
├── config/
│   └── env.schema.ts   # Zod-validated env vars
└── main.ts         # Bootstrap: versioning, global pipes/filters, CORS
prisma/
└── schema.prisma   # User, RefreshToken models
```

## Docker

```bash
docker-compose up        # postgres + redis + api
```

## Docs

- [docs/solid.md](./docs/solid.md) — SOLID audit of the users module, with the
  before/after for each principle and the findings left open.
- [docs/payments.md](./docs/payments.md) — the payment provider factory: how a
  gateway is chosen at runtime, the shared lifecycle the adapters map onto, and
  the contract suite that keeps them substitutable.
- [docs/notifications.md](./docs/notifications.md) — the notification channel
  strategy: how a user's preferences pick the channels, why a transactional
  message still gets through when they have switched everything off, and what
  `sent` means as opposed to `queued`.
- [docs/aspects.md](./docs/aspects.md) — the `@Cacheable()`, `@Retry()` and
  `@Timed()` method decorators: how metadata written at import time becomes
  behaviour once the container is up, the order they compose in, and the targets
  the weaver refuses to wrap rather than silently no-op on.
- [docs/events.md](./docs/events.md) — the typed domain event bus: how a
  publisher stays ignorant of its subscribers, why a failing handler must never
  reach the operation that emitted the event, and what an in-memory bus cannot
  promise you.
- [docs/di-scopes.md](./docs/di-scopes.md) — provider scopes: what `DEFAULT`,
  `REQUEST` and `TRANSIENT` do to instance lifetime, how one request-scoped
  dependency silently converts every consumer above it, what that actually
  costs (measured), and the two ways to reach request data without paying it.
- [docs/idempotency.md](./docs/idempotency.md) — the `Idempotency-Key` header:
  what a client sends and what each answer means, how a retry is told apart from
  a key reused for a different request, why an unreachable store refuses the
  request rather than running it, and what the in-memory store cannot promise
  you.
- [docs/optimistic-concurrency.md](./docs/optimistic-concurrency.md) — the
  `ETag` / `If-Match` loop: how a client reads a validator and writes against
  it, what 412 and 428 each mean and the order they are evaluated in, why the
  validator is a version counter rather than a digest of the body, and how the
  version predicate rides along in the `WHERE` clause so there is no window
  between checking and writing.
- [docs/pessimistic-locking.md](./docs/pessimistic-locking.md) — row locks in an
  interactive transaction: when blocking beats retrying, why a lock only means
  anything inside a transaction, the foreign-key trap that makes `FOR UPDATE` on
  a parent row stall every child insert, how sorting keys keeps two callers from
  deadlocking, and why the suites that assert any of it need a real Postgres.
- [docs/distributed-locking.md](./docs/distributed-locking.md) — Redlock and the
  `@Lock()` decorator: what a lease can and cannot promise, why every
  acquisition carries a monotonic fencing token and how one is drawn from a
  quorum, how a lock that could not be renewed is reported rather than hidden,
  and when a Postgres row lock is the better answer.
- [docs/outbox.md](./docs/outbox.md) — the transactional outbox: why an event
  has to be staged inside the caller's transaction rather than emitted beside
  it, why the relay holds its transaction across the broker call instead of
  taking a lease, what `FOR UPDATE SKIP LOCKED` buys when several replicas relay
  at once, why delivery is at-least-once and what that requires of a subscriber,
  and the ordering the claim does _not_ give you.
- [docs/messaging.md](./docs/messaging.md) — the Kafka producer and consumer:
  why the producer must acknowledge durably or the outbox is at-most-once again,
  why a committed offset is the _next_ message rather than the last one handled,
  what a consumer group is and what happens when every replica gets its own,
  why the whole catalogue shares one topic keyed by the aggregate, why the
  retry ladder holds its partition instead of hopping onto retry topics, and
  what a poison message carries with it to the dead-letter topic.
- [docs/schema-registry.md](./docs/schema-registry.md) — event schema contracts:
  why a TypeScript interface stops at the process boundary, why a subject is the
  event name rather than the topic, what FULL _transitive_ compatibility rules
  out and why a rolling deploy needs both directions, why every object is an open
  content model, why the schema profile refuses the keywords it cannot reason
  about, and how the JSON catalogue is kept from drifting away from the
  TypeScript one.
- [docs/streaming.md](./docs/streaming.md) — the Server-Sent Events endpoint:
  why the keep-alive carries an `id` and no data and is therefore invisible to
  clients, why a resume cursor is not just a number and what an epoch mismatch
  saves you from, why the replay window shrinks as traffic rises, why the stream
  is filtered per subscriber rather than broadcast, why the access token is not
  accepted in the query string, and what a connection cap is bounding that
  nothing else in the request path is.
- [docs/realtime.md](./docs/realtime.md) — the WebSocket gateway at
  `/v1/realtime`: why a Nest guard cannot authenticate a handshake and what is
  done instead, how a browser gets a token onto an upgrade without putting it in
  a URL, why a room is an interest filter and never a permission, what happens
  to a peer that stops reading and why dropping is safe only because it is
  announced, why the farewell has to be sent from `beforeApplicationShutdown`,
  and what this transport gives up against SSE.
- [docs/cqrs.md](./docs/cqrs.md) — the users module split into commands,
  queries and one projection: what the split actually bought (including the
  cached admin list that never saw a new registration), why the CQRS `EventBus`
  is fed by the domain event bus and never the other way round, what an
  `@EventsHandler` may therefore be trusted with, why `UnhandledExceptionBus`
  needs a subscriber before a dead projection is even visible, why eviction
  stays synchronous while projection does not, and why `CqrsModule.forRoot()`
  must be imported exactly once.
- [docs/saga.md](./docs/saga.md) — the checkout saga: why there is no
  transaction that spans a payment gateway and a database and what is bought
  back instead, why the shipment is the pivot and payment comes after stock,
  what at-least-once execution demands of every participant (and the two
  different ways they satisfy it), why a saga takes a lease where the outbox
  holds a lock, why a lease shorter than a step means charging twice, why a
  failed compensation is `STUCK` rather than `COMPENSATED`, and why renaming a
  step is a data migration.

## Testing

```bash
pnpm test          # unit suites, no external services
pnpm test:e2e      # the whole application over HTTP, on in-memory doubles
pnpm test:db       # row-locking, outbox and saga-store suites — needs Postgres and DATABASE_URL

# The Redlock legs of `pnpm test` need independent Redis nodes. Without
# REDLOCK_NODES (or REDIS_URL, for the single-node leg) they are reported as
# pending rather than quietly passing.
for port in 6379 6380 6381; do redis-server --port $port --daemonize yes; done

# The Kafka leg of the message-broker contract needs a cluster. Without
# KAFKA_BROKERS it is reported as pending rather than quietly passing; CI runs
# a single-node KRaft broker as a service and sets it.
docker compose up -d kafka
KAFKA_BROKERS=localhost:29092 pnpm test
REDLOCK_NODES=redis://127.0.0.1:6379,redis://127.0.0.1:6380,redis://127.0.0.1:6381 pnpm test
```

`pnpm test:db` has no skip-if-absent branch: it asserts properties of Postgres
itself, and a suite that passed without a database would be reporting that the
database behaves correctly while never having asked it. Start one with
`docker-compose up postgres -d` and apply `pnpm db:migrate:prod` first.

## Spec Progress

See [SPEC.md](./SPEC.md) for the full feature roadmap.
