// Set environment variables before any module is loaded so ConfigModule / Zod validation passes.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test_db";
process.env["JWT_SECRET"] = "test-jwt-secret-key-that-is-long-enough-for-tests";
process.env["JWT_ACCESS_EXPIRY"] = "15m";
process.env["JWT_REFRESH_EXPIRY"] = "7d";
process.env["ALLOWED_ORIGINS"] = "*";
process.env["PORT"] = "0";
