import type { PrismaClient } from "@prisma/client";
import type { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";

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
 * The tenant every `*.db-spec.ts` row belongs to unless the suite says otherwise.
 *
 * It is the row `20261002000000_add_multi_tenancy` inserts, and the tenant
 * `TENANCY_DEFAULT_TENANT_ID` resolves to — so a suite that says nothing about
 * tenancy is writing the rows a single-tenant deployment writes.
 */
export const TEST_TENANT_ID = "default";

/**
 * {@link databaseUrl} with a session-level tenant attached.
 *
 * `users` and `orders` take their `tenantId` from `require_tenant_id()`, which
 * reads `app.current_tenant_id` and refuses to be absent — so an insert with no
 * tenant anywhere in scope fails, which is the whole point of the default. The
 * suites in this directory are about row locks, outbox claims and hash chains
 * rather than about tenancy, and threading a tenant through every one of their
 * fixtures would be noise in seventeen places.
 *
 * Postgres's `options` connection parameter sets the GUC for the whole session, so
 * every connection in the pool has it from the moment it is opened. That is not a
 * trick for tests: it is how a *single-tenant* deployment is configured, and how a
 * deployment with a connection pool per tenant is (docs/multi-tenancy.md). What it
 * is not is safe for a pool shared between tenants, which is why the application
 * sets the tenant per transaction instead and `test/tenant-isolation.db-spec.ts`
 * asserts on the difference.
 */
export function databaseUrlForTenant(tenantId: string = TEST_TENANT_ID): string {
  const url = new URL(databaseUrl());
  url.searchParams.set("options", `-c app.current_tenant_id=${tenantId}`);
  return url.toString();
}

/**
 * A Prisma client on its own connection.
 *
 * Row locks are held by a *transaction*, and a transaction lives on a
 * connection — so a test that wants two transactions contending for the same
 * row genuinely needs two clients. Two `$transaction` calls on one client can
 * be served by one pooled connection and would then serialise for the wrong
 * reason, quietly turning a lock test into a no-op.
 *
 * It is a real `PrismaService` rather than a `PrismaClient` because the adapters
 * these suites exercise now build a tenant-scoped client with `withExtensions()`,
 * which a plain client does not have. The `ConfigService` it wants is one method.
 */
export function createClient(connectionString: string = databaseUrlForTenant()): PrismaService {
  return new PrismaService({
    getOrThrow: () => connectionString,
  } as unknown as ConfigService);
}

/**
 * Almost the identity now that {@link createClient} returns the service itself.
 *
 * It stays for the two things that still are not one: `probePrismaQueries` hands
 * back an *extended* client, whose type `PrismaService` is not assignable from, and
 * the name still says the thing worth saying at every call site in this directory —
 * the adapter wants the service.
 *
 * The cast is safe for the adapters that take a probed client because all of them
 * reach only the delegate surface. An adapter that builds a tenant-scoped client
 * with `withExtensions()` — `PrismaUsersRepository`, `PrismaOrderStore` — needs a
 * real service, which is what `createClient()` is.
 */
export function asPrismaService(client: PrismaClient | PrismaService): PrismaService {
  return client as PrismaService;
}

/** Deletes every row, respecting the cascade from users to refresh tokens. */
export async function truncateAll(client: PrismaClient): Promise<void> {
  // Tokens before families before users: each is the child of the next, and
  // deleting in this order means the cascade never has to be relied on for
  // something a suite is about to assert the absence of.
  await client.refreshToken.deleteMany({});
  await client.refreshTokenFamily.deleteMany({});
  await client.user.deleteMany({});
}

let sequence = 0;

/** A unique, obviously-fake address, so parallel runs cannot collide on the unique index. */
export function uniqueEmail(prefix = "db-spec"): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}@example.test`;
}
