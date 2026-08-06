# Spec: boilerplate-nestjs-api

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)

- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR
- [x] Add a CI job matrix covering the supported Node version and fail the build on any warning — `engines.node` is `^22.12.0 || ^24.0.0`; lint, type check, and test run on both (PR #23)

Phase 0 complete as of PR #23 (2026-07-29): install, typecheck, lint, format,
216 unit tests, 36 e2e tests, and the Docker image all green in CI on Node 22
and Node 24.

## Phase 1 — Foundation

- [x] NestJS 11 + TypeScript 6 scaffold with strict mode, pnpm, path aliases
- [x] Prisma 7 + PostgreSQL schema (User, RefreshToken) with migrations
- [x] Configuration module with Zod-validated env vars
- [x] Global validation pipe (class-validator + class-transformer)
- [x] Global exception filter with structured JSON error responses

## Phase 2 — Auth

- [x] JWT auth: login, register, access + refresh token rotation
- [x] OAuth 2.0 Google strategy (Passport.js)
- [x] Guards: JwtAuthGuard, RolesGuard with @Roles() decorator
- [x] Password hashing with argon2, rate limiting on auth routes

## Phase 3 — API Design

- [x] Swagger/OpenAPI 3.1 with bearer auth, decorators, examples
- [x] Versioned REST API (v1) with consistent response envelope
- [x] Pagination helper (cursor-based) + `@Paginate()` decorator
- [x] Request logging interceptor (correlation ID, latency, user)

## Phase 4 — Users Module

- [x] UsersModule: CRUD endpoints, DTOs, Prisma repo pattern
- [x] File upload (S3-compatible) with Multer + presigned URLs
- [x] User preferences JSON column with typed Prisma extension

## Phase 5 — Resilience

- [x] Health check endpoint (Terminus: DB, memory, disk)
- [x] Redis caching layer with `@CacheKey` + TTL decorators
- [x] Background jobs with BullMQ (email queue example)
- [x] Graceful shutdown with `enableShutdownHooks()`

## Phase 6 — Testing

- [x] Jest unit tests for AuthService, UsersService with Prisma mock
- [x] E2E tests with Supertest: auth flows, CRUD, error cases
- [x] Factory helpers for test data (Prisma + Faker)
- [x] Coverage thresholds: 80% lines/functions

## Phase 7 — DevOps

- [x] GitHub Actions: lint → typecheck → test → build → Docker push
- [x] Multi-stage Dockerfile (builder + runner, non-root user)
- [x] docker-compose.yml with postgres + redis + api
- [x] Helm chart skeleton for Kubernetes deploy

## Phase 8 — SOLID & Design Patterns

- [x] SOLID audit: split fat repository interfaces (ISP), invert concrete deps to injection tokens (DIP), document each principle with a before/after in `docs/solid.md` — `UsersRepository` split into `UserReader`/`UserWriter`/`UserPreferencesStore` behind `Symbol` tokens, ownership rules extracted to `UserAccessPolicy`, and a shared store contract run against both the Prisma adapter and a new in-memory implementation (PR #24)
- [x] Factory pattern: `PaymentProviderFactory` resolving Stripe/PayPal/mock at runtime from config — resolution is per call rather than a boot-time `useFactory` binding, and the factory is built from an injected `PAYMENT_PROVIDERS` collection so it names no implementation; both real gateways go over their REST APIs (PayPal deprecated its server SDK). Neither gateway leaves its terminal status when money is refunded, so the refunded total decides the tail of the lifecycle — read off Stripe's expanded `latest_charge` and off PayPal's `payments.refunds` minus the FAILED/CANCELLED ones. Buyer approval could not be hidden behind the port, so `authorize()` may return `requires_action` with a redirect or client secret. One behavioural contract runs against all three providers, the HTTP pair driven by in-process API fakes. Selecting a gateway without its credentials is now a boot failure. `Stripe-Version` is sent only when `STRIPE_API_VERSION` is set: a dated version string Stripe does not recognise is a 400 on every request and none could be verified from CI (PR #25)
- [x] Strategy pattern: pluggable `NotificationStrategy` (email, SMS, push) selected per user preference — `NotificationChannel` is the strategy and `NotificationDispatcher` the context, selecting in four stages (preferences, registered, configured, reachable) and reporting why each channel was dropped. Channels are attempted concurrently and each catches its own failure, so one dead transport neither aborts nor delays the others and nothing throws at the caller. Preferences fully govern marketing; a transactional message whose user disabled every channel still goes out by email, as a floor rather than an override. `sent` and `queued` are distinct because email hands off to BullMQ rather than to a third party. Twilio and Expo go over their REST APIs, driven in tests by in-process fakes. Push requires `EXPO_ACCESS_TOKEN` to count as configured — Expo's endpoint accepts unauthenticated requests, so anyone holding a device token could otherwise push to it. Fixed a pre-existing data-loss bug on the way: a patch arrives as a DTO instance whose untouched fields are `undefined`, so `{...current, ...patch}` erased every preference the caller did not name (PR #26)
- [ ] Decorator pattern: `@Cacheable()`, `@Retry()`, `@Timed()` method decorators built on `Reflect.metadata`
- [ ] Observer pattern: typed domain event bus on `EventEmitter2` with `@OnEvent` handlers
- [ ] Adapter pattern: `StorageAdapter` interface with S3, local-disk, and in-memory implementations
- [ ] Provider scopes: DEFAULT vs REQUEST vs TRANSIENT demo module + `docs/di-scopes.md` on the request-scoped performance trap

## Phase 9 — Concurrency & Data Integrity

- [ ] Idempotency middleware: `Idempotency-Key` header, Redis dedupe store, replay of the original response on retry
- [ ] Optimistic concurrency: `version` column + `ETag`/`If-Match` on mutating endpoints, 412 on conflict
- [ ] Pessimistic locking: `SELECT ... FOR UPDATE` inside a Prisma interactive transaction
- [ ] Distributed lock via Redlock exposed as a `@Lock()` decorator with TTL + fencing token
- [ ] CPU-bound work offloaded to a `worker_threads` pool (piscina) with a bounded queue
- [ ] Immutability: `readonly` DTOs, deep-freeze in dev, structural-sharing update helpers
- [ ] Transactional outbox: domain event written in the same Prisma tx, relay poller publishes to the broker

## Phase 10 — Streaming & Messaging

- [ ] Kafka producer + consumer (KafkaJS) with consumer groups and manual offset commits
- [ ] Dead-letter topic with exponential-backoff retry ladder
- [ ] Schema contract validation against a JSON Schema registry, reject on incompatible evolution
- [ ] Server-Sent Events endpoint with heartbeat, `Last-Event-ID` resume, and cleanup on disconnect
- [ ] WebSocket gateway with JWT handshake auth, rooms, and backpressure-aware emits
- [ ] CQRS with `@nestjs/cqrs`: commands, queries, and event handlers split by write/read model
- [ ] Saga orchestration for a multi-service order flow with compensating transactions

## Phase 11 — Resilience & Observability

- [ ] Circuit breaker + retry with full jitter (opossum) on all outbound HTTP
- [ ] Bulkhead isolation with per-dependency concurrency caps and hard request timeouts
- [ ] OpenTelemetry traces, metrics, and logs with W3C `traceparent` propagation
- [ ] Prometheus RED metrics endpoint + a checked-in Grafana dashboard JSON
- [ ] Tamper-evident audit log: append-only table with a per-row hash chain
- [ ] N+1 query detection in tests + DataLoader batching for hot relations

## Phase 12 — Security Hardening

- [ ] Helmet with a strict CSP, HSTS preload, and a CORS allowlist driven by env
- [ ] mTLS for service-to-service calls: cert loading, peer verification, rotation notes
- [ ] Refresh-token reuse detection with whole-family revocation on replay
- [ ] Field-level encryption at rest (AES-256-GCM) with envelope keys from KMS
- [ ] PII redaction in logs via a structlog-style processor with an allowlist
- [ ] OWASP API Security Top 10 checklist, each mitigation backed by a failing-then-passing test
- [ ] Multi-tenancy with PostgreSQL row-level security and a tenant-scoped Prisma client

## Phase 13 — TDD & Advanced Testing

- [ ] TDD kata: implement one feature red→green→refactor, one commit per step, documented in `docs/tdd-kata.md`
- [ ] Mutation testing with Stryker + a CI score threshold
- [ ] Property-based tests with fast-check for the pagination and money helpers
- [ ] Testcontainers-backed integration tests against real Postgres + Redis
- [ ] Pact provider-side contract verification wired into CI
