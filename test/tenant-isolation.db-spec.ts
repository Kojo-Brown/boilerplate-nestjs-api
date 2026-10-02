import { randomBytes, randomUUID } from "crypto";
import type { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { ExtendedPrismaClient } from "@/common/prisma/prisma.service";
import { PrismaOrderStore } from "@/orders";
import { PrismaUsersRepository } from "@/users/prisma-users.repository";
import { UNCONDITIONAL } from "@/common/concurrency";
import { createTestFieldEncryption } from "@/test-utils/test-field-encryption";
import {
  MissingTenantContextError,
  RlsEnforcementService,
  TENANT_SCOPED_TABLES,
  outsideAnyTenant,
  runInTenant,
} from "@/tenancy";
import { createClient, databaseUrl, databaseUrlForTenant, uniqueEmail } from "./helpers/db";

/**
 * Tenant isolation, asked of Postgres rather than of the application.
 *
 * This is the suite the whole feature rests on, and it is the only one that can
 * answer the question. Every other tenancy spec in the repository asserts that the
 * application *asks* for a tenant — the right header is read, the right setting is
 * issued, the right claim is minted — and all of that could be perfectly correct
 * against a database where none of it is enforced. What makes a forgotten `where`
 * clause harmless rather than catastrophic is the policy, and a policy is only real
 * when it is evaluated: not for a superuser, not for a role with BYPASSRLS, and
 * (without `FORCE`) not for the table's owner.
 *
 * So this suite provisions the role the application is meant to run as — no
 * superuser, no BYPASSRLS, DML grants and nothing else, exactly what
 * `prisma/rls/app-role.sql` creates for a deployment — and then tries to see and
 * change another tenant's rows through the production adapters.
 *
 * The role is created here rather than by running that script because the script is
 * psql (it needs `\gexec` to pass a password that must not be in a file). What the
 * two have in common is what matters and is asserted below: a login role the
 * policies apply to.
 */
const APP_ROLE = "rls_spec_app";
/** Generated per run. Obviously not a secret, and never written to a file. */
const APP_PASSWORD = `spec-only-${randomBytes(12).toString("hex")}`;

const ACME = "acme";
const GLOBEX = "globex";

/** `databaseUrl()` as the application's own role, with no tenant attached to the session. */
function appRoleUrl(): string {
  const url = new URL(databaseUrl());
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  // No `options=-c app.current_tenant_id=…`, unlike `databaseUrlForTenant`: the
  // point here is a connection that carries no tenant of its own, so that what the
  // application sets per transaction is the only thing in play.
  url.search = "";
  return url.toString();
}

function serviceFor(connectionString: string): PrismaService {
  return new PrismaService({ getOrThrow: () => connectionString } as unknown as ConfigService);
}

describe("Tenant isolation (Postgres row-level security)", () => {
  /** The migration's own role: superuser in CI and in compose, so it bypasses every policy. */
  let admin: PrismaService;
  /** The application's role, which does not. */
  let app: PrismaService;
  /** What `PrismaService.withExtensions()` produces: the tenant-scoped client. */
  let scoped: ExtendedPrismaClient;
  let users: PrismaUsersRepository;
  let orders: PrismaOrderStore;
  let transactions: PrismaTransactionRunner;

  let acmeUserId: string;
  let globexUserId: string;

  beforeAll(async () => {
    admin = createClient();

    await provisionAppRole(admin);

    app = serviceFor(appRoleUrl());
    scoped = app.withExtensions();
    users = new PrismaUsersRepository(app);
    orders = new PrismaOrderStore(app, createTestFieldEncryption());
    transactions = new PrismaTransactionRunner(app);

    await admin.tenant.createMany({
      data: [
        { id: ACME, name: "Acme" },
        { id: GLOBEX, name: "Globex" },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await cleanUp(admin);
    await app.$disconnect();
    await admin.$disconnect();
  });

  beforeEach(async () => {
    await cleanUp(admin);
    // Seeded as the superuser with an explicit tenant, so the fixtures do not
    // depend on the mechanism under test to be put in place.
    const acme = await admin.user.create({
      data: { email: uniqueEmail("acme"), name: "Acme Person", tenantId: ACME },
    });
    const globex = await admin.user.create({
      data: { email: uniqueEmail("globex"), name: "Globex Person", tenantId: GLOBEX },
    });
    acmeUserId = acme.id;
    globexUserId = globex.id;
  });

  describe("the connection the policies apply to", () => {
    it("is not a superuser and does not hold BYPASSRLS", async () => {
      const report = await new RlsEnforcementService(app, {
        get: () => "development",
      } as unknown as ConfigService).inspect();

      expect(report).toEqual({
        role: APP_ROLE,
        bypassesPolicies: false,
        unprotectedTables: [],
      });
    });

    it("is exactly what the migration's own role is not", async () => {
      // The most likely way to deploy this application with no isolation at all is
      // to deploy it correctly and connect as the role that ran the migrations.
      // `RlsEnforcementService` refuses to boot in production against such a role,
      // and this is the fact it is reading.
      const report = await new RlsEnforcementService(admin, {
        get: () => "development",
      } as unknown as ConfigService).inspect();

      expect(report.bypassesPolicies).toBe(true);
    });

    it("has row-level security enabled and forced on every tenant-owned table", async () => {
      // `ENABLE` alone exempts the table's owner, which is the role that runs the
      // migrations and very often the role an operator opens psql as.
      const rows = await admin.$queryRaw<{ table: string; enabled: boolean; forced: boolean }[]>`
        SELECT c.relname::text AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = ANY (${[...TENANT_SCOPED_TABLES]}::text[])
      `;

      expect(rows).toHaveLength(TENANT_SCOPED_TABLES.length);
      expect(rows.every((row) => row.enabled && row.forced)).toBe(true);
    });
  });

  describe("with no tenant in scope", () => {
    it("reads nothing, although the rows are there", async () => {
      // Fail closed, and silently so: the policy predicate is `tenantId =
      // current_tenant_id()`, `current_tenant_id()` is NULL, and NULL is not true
      // for any row. The same statement as the superuser returns both rows.
      await expect(app.user.count()).resolves.toBe(0);
      await expect(admin.user.count()).resolves.toBe(2);
    });

    it("refuses an insert, naming the tenant rather than the constraint", async () => {
      // The column default is `require_tenant_id()`, which raises 42501 rather than
      // returning NULL. A NOT NULL violation would be a true error about the wrong
      // thing; this one says what is actually missing.
      const failure = await app.user
        .create({ data: { email: uniqueEmail("no-tenant") } })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(String(failure)).toContain("no tenant is in scope");
    });

    it("refuses an operation built in a tenant and executed outside it", async () => {
      // Prisma's promises are lazy: this one is *created* inside the scope and run by
      // the `await` outside it, and the tenant is read when it runs. Fail-closed is
      // the only safe reading of that — the alternative would be a statement running
      // under whatever tenant happens to be in scope wherever somebody awaited it.
      const escaped = runInTenant(ACME, () => scoped.user.findMany());

      await expect(escaped).rejects.toThrow(MissingTenantContextError);
    });

    it("refuses before it reaches the database when the read is tenant-scoped", async () => {
      // The client the application reads through does not send a statement it knows
      // cannot mean anything. Both answers are safe; this one has a stack trace
      // pointing at the caller that forgot to say which tenant it was acting for.
      await expect(scoped.user.findMany()).rejects.toThrow(MissingTenantContextError);
    });
  });

  describe("reading as a tenant", () => {
    it("sees its own rows and not the other tenant's", async () => {
      const seen = await runInTenant(ACME, async () => scoped.user.findMany());

      expect(seen.map((row) => row.id)).toEqual([acmeUserId]);
    });

    it("gives each tenant a different answer to the same query", async () => {
      const [acme, globex] = await Promise.all([
        runInTenant(ACME, async () => scoped.user.findMany()),
        runInTenant(GLOBEX, async () => scoped.user.findMany()),
      ]);

      expect(acme.map((row) => row.id)).toEqual([acmeUserId]);
      expect(globex.map((row) => row.id)).toEqual([globexUserId]);
    });

    it("cannot reach another tenant's row by its id", async () => {
      // Which is the case an application-side filter gets wrong most often: a
      // lookup by primary key, where the tenant never comes up.
      const found = await runInTenant(ACME, () => users.findById(globexUserId));

      expect(found).toBeNull();
    });

    it("cannot reach another tenant's row by its unique email", async () => {
      // `users.email` is globally unique, so this address exists and belongs to
      // exactly one row — and the uniqueness does *not* make it visible. That is
      // what makes the login path safe: an address registered in another tenant is
      // simply not there, rather than being found and then checked.
      const globex = await admin.user.findUniqueOrThrow({ where: { id: globexUserId } });

      const found = await runInTenant(ACME, () => users.findByEmail(globex.email));

      expect(found).toBeNull();
    });

    it("sees its own tenant row and no other customer's", async () => {
      const seen = await runInTenant(ACME, async () => scoped.tenant.findMany());

      expect(seen.map((row) => row.id)).toEqual([ACME]);
    });

    it("reads preferences through the extension stacked on top of the scoping", async () => {
      // Order of extensions, asserted: a model extension calls back into the client
      // it was applied to, so `getPreferences`' own `findUnique` is only tenant-scoped
      // because the scoping was applied first. Reversed, these two methods would be
      // the only reads in the application with no tenant — and would quietly answer
      // for nobody.
      await admin.user.update({
        where: { id: acmeUserId },
        data: { preferences: { theme: "dark" } },
      });

      const own = await runInTenant(ACME, () => users.getPreferences(acmeUserId));
      const other = await runInTenant(GLOBEX, () => users.getPreferences(acmeUserId));

      expect(own.theme).toBe("dark");
      // Not an error, and not the other tenant's value: `getPreferences` merges over
      // the defaults, and from `globex` there is no row to merge.
      expect(other.theme).toBe("system");
    });
  });

  describe("writing as a tenant", () => {
    it("fills the tenant column from the transaction, with nothing passing it in", async () => {
      // `PrismaUsersRepository.create` has no tenant parameter and never will: the
      // column's default reads the setting the transaction opened with. That is what
      // makes every existing write path tenant-correct without being rewritten.
      const created = await runInTenant(ACME, () => users.create({ email: uniqueEmail("new") }));

      const asAdmin = await admin.user.findUniqueOrThrow({ where: { id: created.id } });
      expect(asAdmin.tenantId).toBe(ACME);
    });

    it("refuses an insert that names another tenant", async () => {
      // The `WITH CHECK` half of the policy. Without it a tenant could write rows
      // into another tenant — a policy with only `USING` is a read-only defence.
      const failure = await runInTenant(ACME, async () =>
        scoped.user
          .create({ data: { email: uniqueEmail("smuggled"), tenantId: GLOBEX } })
          .catch((error: unknown) => error),
      );

      expect(String(failure)).toContain("row-level security policy");
      await expect(admin.user.count({ where: { tenantId: GLOBEX } })).resolves.toBe(1);
    });

    it("cannot move one of its own rows into another tenant", async () => {
      // `WITH CHECK` is evaluated against the row as it will be, so this is refused
      // even though the row being updated is this tenant's to update.
      const failure = await runInTenant(ACME, async () =>
        scoped.user
          .update({ where: { id: acmeUserId }, data: { tenantId: GLOBEX } })
          .catch((error: unknown) => error),
      );

      expect(String(failure)).toContain("row-level security policy");
      const unchanged = await admin.user.findUniqueOrThrow({ where: { id: acmeUserId } });
      expect(unchanged.tenantId).toBe(ACME);
    });

    it("cannot update another tenant's row, and is told it does not exist", async () => {
      // The `USING` clause filters the rows an UPDATE may find, so a cross-tenant
      // update matches nothing. Prisma reports that as P2025 — the same answer a
      // deleted row gives, which is the right amount to tell the caller.
      const failure = await runInTenant(ACME, () =>
        users
          .update(globexUserId, { name: "Taken over" }, UNCONDITIONAL)
          .catch((error: unknown) => error),
      );

      expect(failure).toBeInstanceOf(Error);
      const untouched = await admin.user.findUniqueOrThrow({ where: { id: globexUserId } });
      expect(untouched.name).toBe("Globex Person");
    });

    it("cannot delete another tenant's row", async () => {
      await runInTenant(ACME, () =>
        users.delete(globexUserId, UNCONDITIONAL).catch(() => undefined),
      );

      await expect(admin.user.count({ where: { id: globexUserId } })).resolves.toBe(1);
    });

    it("writes the tenant of the transaction the runner opened", async () => {
      // The other half of the write story: an adapter inside somebody else's
      // transaction issues no `set_config` of its own, because
      // `PrismaTransactionRunner` already did when it opened the transaction.
      const created = await runInTenant(GLOBEX, () =>
        transactions.run((tx) => users.create({ email: uniqueEmail("in-tx") }, tx)),
      );

      const asAdmin = await admin.user.findUniqueOrThrow({ where: { id: created.id } });
      expect(asAdmin.tenantId).toBe(GLOBEX);
    });
  });

  describe("a second tenant-owned table", () => {
    /** An order for `userId`, written through the production store in `tenant`. */
    const placeOrder = (tenant: string, userId: string): Promise<{ id: string }> =>
      runInTenant(tenant, () =>
        transactions.run((tx) =>
          orders.create(tx, {
            id: randomUUID(),
            userId,
            items: [{ sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 34_900 }],
            total: { amountMinor: 34_900, currency: "GBP" },
            shippingCountry: "GB",
            sagaId: randomUUID(),
          }),
        ),
      );

    it("takes its tenant from the transaction too", async () => {
      const order = await placeOrder(ACME, acmeUserId);

      const asAdmin = await admin.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(asAdmin.tenantId).toBe(ACME);
    });

    it("is invisible to the other tenant, by id", async () => {
      const order = await placeOrder(ACME, acmeUserId);

      await expect(runInTenant(ACME, () => orders.find(order.id))).resolves.toMatchObject({
        id: order.id,
      });
      await expect(runInTenant(GLOBEX, () => orders.find(order.id))).resolves.toBeNull();
    });

    it("is invisible to the other tenant in a list, even listing by its owner's id", async () => {
      // The user id is not a secret — it is in URLs and in tokens — so a list that
      // took it as the only filter would be a cross-tenant read for anybody who had
      // seen one.
      await placeOrder(ACME, acmeUserId);

      const seen = await runInTenant(GLOBEX, () =>
        orders.listForUser({ userId: acmeUserId, limit: 10 }),
      );

      expect(seen).toEqual([]);
    });
  });

  describe("how long the setting lasts", () => {
    it("is gone by the next statement on the same connection", async () => {
      // `set_config(…, true)` is transaction-local, and this is the property that
      // makes a pool safe to share between tenants: the setting cannot outlive the
      // transaction that made it, so the next request to be handed this connection
      // inherits nothing. A session-level `SET` here would make this read return a
      // row — the leak that only ever shows up under concurrency.
      await runInTenant(ACME, async () => scoped.user.findMany());

      await expect(app.user.count()).resolves.toBe(0);
    });

    it("keeps two tenants apart while their queries interleave", async () => {
      const interleaved = await Promise.all([
        runInTenant(ACME, async () => scoped.user.findMany()),
        runInTenant(GLOBEX, async () => scoped.user.findMany()),
        runInTenant(ACME, async () => scoped.user.findMany()),
        runInTenant(GLOBEX, async () => scoped.user.findMany()),
      ]);

      expect(interleaved.map((rows) => rows.map((row) => row.id))).toEqual([
        [acmeUserId],
        [globexUserId],
        [acmeUserId],
        [globexUserId],
      ]);
    });

    it("can instead be set for a whole connection, for a pool that serves one tenant", async () => {
      // The deployment model `docs/multi-tenancy.md` describes as the alternative to
      // a setting per transaction: Postgres's `options` parameter sets the GUC when
      // the connection opens, so every statement on it is already scoped and the
      // extra statement per query is gone. It is what `test/helpers/db.ts` uses, and
      // it is only safe when the pool is never shared between tenants.
      const perTenant = serviceFor(withRole(databaseUrlForTenant(GLOBEX)));
      try {
        // No `runInTenant`, and no extension: the connection itself carries the
        // tenant.
        const seen = await perTenant.user.findMany();

        expect(seen.map((row) => row.id)).toEqual([globexUserId]);
      } finally {
        await perTenant.$disconnect();
      }
    });

    it("leaves the application with nothing when work starts outside a tenant", async () => {
      // `outsideAnyTenant` is what a background pass that is genuinely tenant-less
      // runs in. It is not a way to see everything: the policies still apply, so a
      // tenant-owned table is simply empty.
      const seen = await runInTenant(ACME, async () =>
        outsideAnyTenant(async () => app.user.findMany()),
      );

      expect(seen).toEqual([]);
    });
  });

  describe("the tenants table", () => {
    it("refuses an id that could not be a subdomain", async () => {
      // The same expression as `TENANT_ID_PATTERN`, in the database — because the id
      // arrives in a `Host` header, and one with a dot in it would resolve two ways.
      const failure = await admin.tenant
        .create({ data: { id: "Acme Corp", name: "Acme" } })
        .catch((error: unknown) => error);

      expect(String(failure)).toContain("tenants_id_is_a_slug");
    });

    it("will not let a tenant provision another tenant", async () => {
      // There is a read policy and deliberately no write policy: creating a tenant is
      // an operator action taken through a migration or an admin connection, not
      // something a request can do.
      const failure = await runInTenant(ACME, () =>
        app.tenant
          .create({ data: { id: "invented", name: "Invented" } })
          .catch((error: unknown) => error),
      );

      expect(String(failure)).toContain("row-level security policy");
      await expect(admin.tenant.count({ where: { id: "invented" } })).resolves.toBe(0);
    });

    it("refuses to delete a tenant that still owns rows", async () => {
      // `ON DELETE RESTRICT`. Deleting a customer is a data-retention decision with
      // an order of operations; a cascade here would make it one statement with no
      // confirmation and no way back.
      const failure = await admin.tenant
        .delete({ where: { id: ACME } })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      await expect(admin.tenant.count({ where: { id: ACME } })).resolves.toBe(1);
    });
  });
});

/** `url` with the application role's credentials, keeping its query parameters. */
function withRole(url: string): string {
  const parsed = new URL(url);
  parsed.username = APP_ROLE;
  parsed.password = APP_PASSWORD;
  return parsed.toString();
}

/**
 * Creates the role the policies apply to, with the privileges a deployment grants
 * it and nothing else.
 *
 * The same role `prisma/rls/app-role.sql` provisions: `LOGIN`, `NOSUPERUSER`,
 * `NOBYPASSRLS`, DML on the tables, and no ownership — so it cannot
 * `ALTER TABLE … DISABLE ROW LEVEL SECURITY` its way out of the thing being tested.
 *
 * It needs a superuser connection, which is what CI's `DATABASE_URL` is. There is no
 * skip if it is not: a suite that quietly passed without the role would be reporting
 * that the policies work while never having been subject to one.
 */
async function provisionAppRole(admin: PrismaService): Promise<void> {
  const database = new URL(databaseUrl()).pathname.replace(/^\//, "");

  // The password is generated per run and interpolated rather than bound, because
  // `CREATE ROLE` takes no parameters. `format('%L')` does the quoting inside the
  // DO block.
  await admin.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L',
                       '${APP_ROLE}', '${APP_PASSWORD}');
      ELSE
        EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L',
                       '${APP_ROLE}', '${APP_PASSWORD}');
      END IF;
    END
    $$;
  `);
  await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${database}" TO "${APP_ROLE}"`);
  await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${APP_ROLE}"`);
  await admin.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}"`,
  );
}

/** Removes everything this suite wrote, as the role that can see all of it. */
async function cleanUp(admin: PrismaService): Promise<void> {
  await admin.order.deleteMany({});
  await admin.sagaInstance.deleteMany({});
  await admin.refreshToken.deleteMany({});
  await admin.refreshTokenFamily.deleteMany({});
  await admin.user.deleteMany({});
}
