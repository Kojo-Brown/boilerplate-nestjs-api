import { randomBytes } from "crypto";

// Set environment variables before any module is loaded so ConfigModule / Zod validation passes.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test_db";
process.env["JWT_SECRET"] = randomBytes(32).toString("hex");
process.env["JWT_ACCESS_EXPIRY"] = "15m";
process.env["JWT_REFRESH_EXPIRY"] = "7d";
process.env["ALLOWED_ORIGINS"] = "*";
process.env["PORT"] = "0";

// The outbox relay is driven explicitly by `TestApp.drainOutbox()` rather than
// by a timer. A one-second poll in a suite that finishes in milliseconds would
// make "did the welcome email go out?" a race, and a spec that passed by
// waiting long enough is a spec that will fail on a slower machine.
process.env["OUTBOX_RELAY_ENABLED"] = "false";

// The saga recovery poller, for exactly the same reason and with exactly the
// same replacement: `TestApp.recoverSagas()`. `PlaceOrderHandler` advances a
// checkout inside the request that placed it, so the poller is only ever the
// crash-recovery path — and a spec about crash recovery wants to say when the
// recovery happens rather than sleep until it might have.
process.env["SAGA_RECOVERY_ENABLED"] = "false";

// The SSE endpoint's timings, shrunk so a spec can observe a heartbeat and a
// replay eviction without waiting on the production defaults. This has to be
// here rather than in the spec: `ConfigModule.forRoot` reads and validates the
// environment inside the call itself, which runs when `app.module.ts` is
// imported — anything set in a `beforeAll` lands after the config is already
// frozen, which is the trap `test/messaging.e2e-spec.ts` documents.
// Only the timings are shortened; the buffer keeps a realistic size so eviction
// is exercised deliberately (by a spec that overrides the hub) rather than by
// accident in every other suite.
process.env["SSE_HEARTBEAT_INTERVAL_MS"] = "80";
process.env["SSE_RETRY_HINT_MS"] = "500";

// Test-only credentials — not real secrets, used exclusively in e2e test suites.
process.env["E2E_TEST_PASSWORD"] = "e2e-suite-placeholder-pw-1";
process.env["E2E_WRONG_PASSWORD"] = "wrong-password-e2e-xyz";
