import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaService } from "@/common/prisma/prisma.service";

/**
 * Connection string for the `*.db-spec.ts` suites.
 *
 * `test/jest-db.json` deliberately does not load `helpers/setup-env.ts` the way
 * the e2e config does — that file points `DATABASE_URL` at a database nobody
 * runs, which is exactly right for a suite backed by an in-memory fake and
 * exactly wrong here.
 *
 * These suites deliberately have no fallback and no skip: the properties they
 * assert — that `FOR UPDATE` excludes a second transaction, that a `FOR KEY
 * SHARE` insert conflicts with one lock mode and not another — are properties
 * of Postgres, and a suite that quietly passed without one would be reporting
 * that the database behaves correctly while never having asked it. CI provides
 * the service; `docker compose up -d postgres` provides it locally.
 */
export function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the *.db-spec.ts suites. Start one with " +
        "`docker compose up -d postgres`, apply `pnpm db:migrate:prod`, then re-run.",
    );
  }
  return url;
}

/**
 * A Prisma client on its own connection.
 *
 * Row locks are held by a *transaction*, and a transaction lives on a
 * connection — so a test that wants two transactions contending for the same
 * row genuinely needs two clients. Two `$transaction` calls on one client can
 * be served by one pooled connection and would then serialise for the wrong
 * reason, quietly turning a lock test into a no-op.
 */
export function createClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl() }) });
}

/**
 * A client typed as `PrismaService` for adapters that inject one.
 *
 * The adapters under test touch the `PrismaClient` surface only — model
 * delegates, `$transaction`, `$queryRaw` — never the two lifecycle hooks or
 * `withExtensions`, so a plain client stands in for the service exactly. It is
 * a cast rather than a real `PrismaService` because constructing one requires a
 * `ConfigService`, which would drag Nest's DI into a suite that is about SQL.
 */
export function asPrismaService(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

/** Deletes every row, respecting the cascade from users to refresh tokens. */
export async function truncateAll(client: PrismaClient): Promise<void> {
  await client.refreshToken.deleteMany({});
  await client.user.deleteMany({});
}

let sequence = 0;

/** A unique, obviously-fake address, so parallel runs cannot collide on the unique index. */
export function uniqueEmail(prefix = "db-spec"): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}@example.test`;
}
