-- The database role the application connects as, and the one the row-level
-- security policies actually constrain.
--
-- Run it once per database, as a superuser, after `prisma migrate deploy`:
--
--     psql "$ADMIN_DATABASE_URL" \
--       -v app_role=app_user \
--       -v app_password="$APP_DB_PASSWORD" \
--       -f prisma/rls/app-role.sql
--
-- Then point the application's DATABASE_URL at that role. There is no password
-- in this file and there must never be one: it is passed in as a psql variable
-- and belongs wherever JWT_SECRET lives.
--
-- Why a second role at all, when the policies are already on the tables: a
-- policy does not apply to a superuser, and `FORCE ROW LEVEL SECURITY` only
-- removes the *owner's* exemption, not a superuser's. An application connecting
-- as `postgres` — which is what every quickstart, docker-compose file and CI
-- service hands you — sees every tenant's rows no matter what any policy says.
-- The isolation this schema claims is therefore a property of the connection as
-- much as of the tables, which is why `RlsEnforcementService` refuses to boot in
-- production against a role that bypasses it.
--
-- This role is deliberately not the owner of anything. Migrations run as the
-- owner, the application runs as this role, and the separation is what stops a
-- compromised request from issuing `ALTER TABLE … DISABLE ROW LEVEL SECURITY`.

\set ON_ERROR_STOP on

-- NOBYPASSRLS and NOSUPERUSER are the whole point and are stated explicitly
-- rather than left to the defaults, which is where somebody reading this file
-- looks first.
--
-- `\gexec` rather than a `DO` block, because psql does not interpolate its
-- variables inside dollar-quoted text: `:'app_password'` in a `DO $$ … $$` body
-- would be sent to the server verbatim and the role would end up with a literal
-- password of `:'app_password'`. This form builds the statement in SQL, where
-- `format('%I'/%L')` also does the quoting, and executes the result.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_role', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec

-- Re-running the script resets the flags and the password of a role that is
-- already there, which is what makes it safe to run after an upgrade that adds a
-- table — and what makes it the one place a rotation happens.
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_role', :'app_password')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec

-- Connect, and see the schema. Neither is granted by default to a fresh role on
-- a modern Postgres: `public` has had its implicit CREATE grant removed since 15,
-- and USAGE is what makes the tables addressable at all.
GRANT CONNECT ON DATABASE :"DBNAME" TO :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

-- DML on every table, and nothing else. No TRUNCATE (it is not filtered by a
-- policy — a tenant truncating `users` would take every tenant's rows with it),
-- no REFERENCES, no owner privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- The same for whatever the next migration adds, so a new table is not silently
-- unreachable until somebody remembers to re-run this script. It applies to
-- tables created by the role running this statement, which is the role that runs
-- the migrations — if those are two different roles, repeat this `ALTER DEFAULT
-- PRIVILEGES` with `FOR ROLE <migration role>`.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

-- A new table is not covered by a policy until somebody writes one, and a table
-- with RLS off is readable across every tenant. This reports the tenant-owned
-- tables that are not protected, so the omission is visible at the moment the
-- role is (re)provisioned rather than after it matters.
DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE WARNING 'These tables have a tenantId column but no enforced row-level security: %. Add a policy, or they are shared across every tenant.', unprotected;
  END IF;
END
$$;
