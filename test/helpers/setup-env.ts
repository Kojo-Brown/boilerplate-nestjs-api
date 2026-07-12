// Set environment variables before any module is loaded so ConfigModule / Zod validation passes.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test_db";
process.env["JWT_SECRET"] = "test-jwt-secret-key-that-is-long-enough-for-tests";
process.env["JWT_ACCESS_EXPIRY"] = "15m";
process.env["JWT_REFRESH_EXPIRY"] = "7d";
process.env["ALLOWED_ORIGINS"] = "*";
process.env["PORT"] = "0";

// Test-only credentials — not real secrets, used exclusively in e2e test suites.
process.env["E2E_TEST_PASSWORD"] = "e2e-suite-placeholder-pw-1";
process.env["E2E_WRONG_PASSWORD"] = "wrong-password-e2e-xyz";
