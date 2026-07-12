# Spec: boilerplate-nestjs-api

> Spec-driven. Mark `[x]` only after pushing.

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
- [ ] GitHub Actions: lint → typecheck → test → build → Docker push
- [ ] Multi-stage Dockerfile (builder + runner, non-root user)
- [ ] docker-compose.yml with postgres + redis + api
- [ ] Helm chart skeleton for Kubernetes deploy
