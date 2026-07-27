import { defineConfig } from "prisma/config";

/**
 * Prisma 7 moved connection URLs out of `schema.prisma` and into this file.
 * The URL here is only consumed by the CLI (migrate, db push, studio); the
 * runtime client gets its connection from the driver adapter in `PrismaService`.
 *
 * It is read straight from `process.env` — and omitted entirely when unset — so
 * that `prisma generate` works in CI before any database exists. Commands that
 * genuinely need a database still fail loudly with Prisma's own error.
 */
const databaseUrl = process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
