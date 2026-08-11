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

## Spec Progress

See [SPEC.md](./SPEC.md) for the full feature roadmap.
