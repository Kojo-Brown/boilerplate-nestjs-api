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
- [x] Decorator pattern: `@Cacheable()`, `@Retry()`, `@Timed()` method decorators built on `Reflect.metadata` — the decorators only write metadata, because one runs while the class body is evaluated and has no cache or clock to close over; `AspectWeaver` reads it back on `onModuleInit` and installs chains over the injected collaborators. Weaving covers singleton providers and reports the two cases it cannot reach rather than silently no-op on them: `registerRouter()` runs before `callInitHook()`, so a controller's handler is already bound, and Nest keeps an `Object.create(prototype)` placeholder for request/transient providers, so the presence of an instance proves nothing. Composition order is fixed by the weaver (Timed → Cacheable → Retry), so a cache hit costs no retries and the recorded duration includes the backoff the caller waited through. Cached values are boxed so a resolved `undefined` is a hit; rejections are never cached; concurrent misses collapse into one call; an unkeyable argument, a dead store or a failed write degrade to calling through, since a cache may never turn a working call into a failing one (PR #27)
- [x] Observer pattern: typed domain event bus on `EventEmitter2` with `@OnEvent` handlers — `DomainEventPayloads` is the one catalogue of names and shapes, and `@OnDomainEvent(name)` wraps `@OnEvent` to constrain a handler's parameter to that event, so a renamed payload field is a compile error rather than a runtime `undefined` in a subscriber nobody grepped for. It also wraps the method: listeners run on the publisher's stack, so an uncontained failure would fail the operation that emitted the event — the exact coupling the pattern removes. The framework's own catch was not enough, because it logs `error.message` with no event, id or handler, and a swallowed rejection is indistinguishable from a handler that returned nothing, so nothing could report _which_ subscriber failed. `publish` returns once handlers have started and is deliberately not `async`; `publishAndSettle` waits and names every outcome. Wired to `user.registered` (both real registration paths, not the Google link-to-existing one) and `user.deleted`, which carries the address because the row is gone by the time a subscriber runs; `WelcomeEmailListener` subscribes and gave `sendWelcomeEmail` its first caller. Delivery is in-process and in-memory, so nothing survives a crash or reaches another replica — the outbox item in Phase 9 is the fix, and `docs/events.md` says not to put anything a user would notice missing on the bus (PR #28)
- [x] Adapter pattern: `StorageAdapter` interface with S3, local-disk, and in-memory implementations — the port is written to S3's semantics (flat keyspace, atomic whole-object writes) because that is the direction the mismatch survives; `STORAGE_ADAPTER` selects one at boot and nothing else in `src` names an implementation. Presigning is a separate interface rather than a method that throws on two of three backends, since a signature is something the _store_ verifies and a disk has nothing to verify one with — the endpoints answer 501, not 503, because no configuration will ever make them work. One behavioural contract runs against all three and immediately caught the in-memory adapter throwing _synchronously_ where the others rejected, which would have crashed any caller using `.catch()` against the one backend every other suite runs on. It also forced two divergences closed rather than documented: keys are validated against the stricter of S3's and the filesystem's limits (including a 255-byte-per-segment cap S3 does not impose), and the local adapter stores each key as a directory holding `.object`/`.meta.json`, because `<root>/<key>` cannot hold `a/b` and `a/b/c` at once — `avatars/<id>` beside `avatars/<id>/thumb` would have worked on S3 and failed on disk. Two real defects fixed on the way: the presigner signed `host` alone, making `ContentType` a suggestion a client could ignore to serve `text/html` from the bucket's own origin, and `STORAGE_ADAPTER=memory` is now refused at boot in production, since unlike every other misconfiguration it raises no error anyone sees — uploads succeed and the files are gone after a restart. S3 is driven in tests by an in-process fake of its HTTP API installed as the SDK's `requestHandler`, reached through the same optional DI token an operator would use to tune retries, so no test-only branch exists in the adapter (PR #29)
- [x] Provider scopes: DEFAULT vs REQUEST vs TRANSIENT demo module + `docs/di-scopes.md` on the request-scoped performance trap — the demo is built around the failure rather than the taxonomy: `AuditTrailService` is a plain `@Injectable()` whose accumulate-then-flush buffer never sees more than one request, because it injects a request-scoped provider four lines away, and `DiScopesController` inherits the scope in turn without declaring anything. `SingletonAuditTrail` is the same class with the correlation id passed as an argument, and `RequestContextResolver` is the escape hatch for where that cannot reach — `ModuleRef.resolve` keyed by the request's own context id, which returns the instance the router already built rather than a second one. `ScopeAudit` reads back `InstanceWrapper.isDependencyTreeStatic()` — the computation Nest itself uses — and names both the components rebuilt per request and the dependency chain responsible; the e2e suite pins the exact set, so injecting a request-scoped provider into `UsersService` turns CI red instead of silently converting half the container. Measured rather than asserted (`pnpm bench:scopes`): resolution goes 0.5µs → ~36µs, but end to end that is 11–22% on a handler that does nothing and unmeasurable next to one Postgres round trip, so the doc's thesis is the memoised state a singleton stops keeping, not the microseconds. Two framework behaviours it relies on are pinned by `scope-caveats.spec.ts`: lifecycle hooks never fire on a request-scoped provider, and a request-scoped global enhancer is rebuilt for every route in the application. Two defects fixed on the way — the resolver minted a fresh context per call for any carrier the router never touched, and the ledger kept every instance id forever, a leak on a per-request provider (PR #30)

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
