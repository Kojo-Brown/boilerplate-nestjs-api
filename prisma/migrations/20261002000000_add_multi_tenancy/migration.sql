-- Multi-tenancy, enforced by Postgres rather than by every `where` clause in the
-- application. See docs/multi-tenancy.md.
--
-- The argument for putting the isolation here is that the application-side
-- version of it cannot be verified. "Every query filters by tenant" is a
-- property of hundreds of call sites, each of which is one forgotten clause away
-- from serving another customer's rows, and nothing in a diff, a type or a test
-- run says which ones are missing it. A policy is one statement per table that
-- the planner adds to every statement anybody writes — including the ones nobody
-- has written yet, and including the ad-hoc `UPDATE` somebody runs in psql under
-- the application's role at 2am.
--
-- Three pieces make it work:
--   * `current_tenant_id()` reads the tenant out of a session variable, which is
--     set per transaction by the application (see src/tenancy).
--   * `require_tenant_id()` is the same value and refuses to be absent. It is
--     the column default, so an insert with no tenant in scope fails loudly
--     instead of attributing a row to whoever happens to be first in the table.
--   * the policies compare the column to the setting, on read and on write.
--
-- And one thing that is *not* here: the role the application connects as. A
-- policy does not apply to a superuser or to a role with BYPASSRLS, so RLS
-- against a connection owned by `postgres` is decoration. `prisma/rls/app-role.sql`
-- creates the role that the policies actually constrain, and
-- `RlsEnforcementService` checks at boot that this deployment is using one.

-- ---------------------------------------------------------------------------
-- The tenant itself
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- The id is a slug an operator chooses, because it arrives in a `Host` header or
-- an `X-Tenant-Id` header and is compared against a column with no lookup in
-- between. The shape is therefore load-bearing and belongs in the database as
-- well as in `isTenantId`: an id containing a dot would resolve two ways under
-- subdomain routing, and one containing an upper-case letter would resolve one
-- way in a hostname (which is case-insensitive) and another in the column.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_id_is_a_slug" CHECK ("id" ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$');

-- Every deployment has at least one tenant, and a single-tenant deployment has
-- exactly this one: `TENANCY_DEFAULT_TENANT_ID` defaults to `default`, so a
-- clean clone boots, registers users and places orders with no tenancy
-- configuration at all. The rows that already exist when this migration runs
-- belong to it, because before this migration there was nowhere else for them
-- to belong.
--
-- Renaming it afterwards is possible — the foreign keys below are ON UPDATE
-- CASCADE, so `UPDATE "tenants" SET "id" = 'acme'` carries every row with it —
-- but it invalidates every issued access token (they name the tenant in `tid`)
-- and every URL that named the old slug.
INSERT INTO "tenants" ("id", "name", "createdAt", "updatedAt")
VALUES ('default', 'Default tenant', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Reading the tenant of the current transaction
-- ---------------------------------------------------------------------------

-- `app.current_tenant_id` is a custom GUC, which Postgres allows for any
-- qualified name it does not recognise. The application sets it with
-- `set_config(…, true)` — transaction-local — at the start of every transaction,
-- which is the only form that is safe behind a connection pool: a plain `SET`
-- outlives the request and the next request to be handed that connection would
-- inherit it.
--
-- The second argument to `current_setting` is `missing_ok`. Without it an unset
-- GUC raises 42704 rather than returning NULL, which would turn every query made
-- outside a tenant context into an error even where zero rows is the right
-- answer. `nullif` folds the empty string into NULL as well, because
-- `set_config(…, '', true)` is how a caller clears it.
--
-- STABLE, not IMMUTABLE: the value changes between transactions. PARALLEL SAFE
-- is deliberate and is not free to get wrong in either direction — a parallel-
-- unsafe function in a policy predicate disables parallel plans for every query
-- against these tables, and it is safe here because parallel workers are given a
-- copy of the leader's GUC state before they start.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'The tenant of the current transaction, or NULL when none is in scope. Read by every row-level-security policy in this schema.';

-- The same value, as a column default, where NULL has to be a failure instead of
-- a NULL: a row written with no tenant in scope is not an empty result anybody
-- can recover from, it is data attributed to the wrong customer or a NOT NULL
-- violation whose message says nothing about tenancy.
--
-- 42501 (insufficient_privilege) rather than a bare `RAISE`, so the application
-- can tell this apart from a constraint violation, and so a log line carries a
-- code somebody can search for.
CREATE OR REPLACE FUNCTION require_tenant_id() RETURNS text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
AS $$
DECLARE
  resolved text;
BEGIN
  resolved := current_tenant_id();
  IF resolved IS NULL THEN
    RAISE EXCEPTION 'no tenant is in scope for this transaction'
      USING ERRCODE = '42501',
            HINT = 'Set app.current_tenant_id with set_config(''app.current_tenant_id'', $tenant, true) at the start of the transaction. In this application that is what TenantPrisma and PrismaTransactionRunner do from the tenant context; outside a request, wrap the work in runInTenant().';
  END IF;
  RETURN resolved;
END
$$;

COMMENT ON FUNCTION require_tenant_id() IS
  'The tenant of the current transaction, raising 42501 when none is in scope. The default of every tenant_id column.';

-- ---------------------------------------------------------------------------
-- The tenant column on every tenant-owned table
-- ---------------------------------------------------------------------------
--
-- Two tables, and the list is a decision rather than an omission. `users` and
-- `orders` hold what belongs to a customer. The tables that do not get a policy
-- are the ones whose only readers are cross-tenant by construction:
--
--   * `outbox_events` and `saga_instances` are claimed by background pollers
--     that run under no request and must see every tenant's rows — a policy here
--     would stop the relay dead, and a tenant column with a raising default
--     would stop it being written at all.
--   * `audit_log` is a hash chain over every entry in the deployment. Filtering
--     it per tenant would make `AuditChainVerifier` report a broken chain to
--     every reader, because the entry before the one it can see would be
--     invisible.
--   * `refresh_tokens` and `refresh_token_families` are keyed by an unguessable
--     secret and are read before the request has been authenticated, so there is
--     no authenticated tenant to compare against yet. The tenant check happens
--     one step later, when the token's user is loaded through a policy-covered
--     read of `users`.
--
-- Each of those is reachable only through code that already has the tenant it
-- needs in hand (an event payload, a saga's state, an audit entry's actor), and
-- docs/multi-tenancy.md says what to do if you decide otherwise.

-- The literal is the backfill: every row that exists now belongs to the tenant
-- inserted above. The default becomes `require_tenant_id()` immediately after,
-- so this value is never used again — a literal left in place as the default
-- would be exactly the silent misattribution the raising default exists to
-- prevent.
-- AlterTable
ALTER TABLE "users" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "users" ALTER COLUMN "tenantId" SET DEFAULT require_tenant_id();

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "orders" ALTER COLUMN "tenantId" SET DEFAULT require_tenant_id();

-- An order belongs to the tenant of the customer who placed it. On a deployment
-- with one tenant this changes nothing; it is here because the statement above
-- backfilled a constant, and a constant is only right while there is one tenant.
UPDATE "orders" o
   SET "tenantId" = u."tenantId"
  FROM "users" u
 WHERE u."id" = o."userId"
   AND u."tenantId" <> o."tenantId";

-- CreateIndex
CREATE INDEX "users_tenantId_createdAt_idx" ON "users"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_tenantId_createdAt_idx" ON "orders"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The policies
-- ---------------------------------------------------------------------------
--
-- `ENABLE` turns the policies on for every role except the table owner and
-- anybody with BYPASSRLS. `FORCE` removes the owner's exemption, which matters
-- because the owner here is whichever role runs the migrations and is very often
-- the role an operator opens psql as. A superuser still bypasses both — that is
-- not something a table can opt out of, and it is why the application must not
-- connect as one.
--
-- `USING` is the read half: it is added as a predicate to every SELECT, and to
-- the rows an UPDATE or DELETE is allowed to find. `WITH CHECK` is the write
-- half: it is evaluated against the row as it will be after an INSERT or UPDATE.
-- Both are needed, and for different attacks. Without `WITH CHECK` a tenant
-- could insert rows into another tenant, or move its own rows out of its reach.
-- Without `USING` it could read everything.
--
-- With `current_tenant_id()` NULL the predicate is NULL, which is not true, so
-- no row satisfies it: an unset tenant reads nothing and writes nothing. That is
-- the right default for a mistake — it fails closed, visibly, and never serves
-- the wrong customer.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

-- A tenant may read its own row and nothing else, which is what keeps the
-- customer list out of a compromised request. There is deliberately no write
-- policy: provisioning a tenant is an operator action taken through a migration
-- or an admin connection, not something a request can do.
CREATE POLICY "tenants_self_read" ON "tenants"
  FOR SELECT
  USING ("id" = current_tenant_id());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_tenant_isolation" ON "users"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;

CREATE POLICY "orders_tenant_isolation" ON "orders"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());
