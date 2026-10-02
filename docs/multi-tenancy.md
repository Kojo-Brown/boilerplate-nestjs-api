# Multi-tenancy with row-level security

One deployment, several customers, and no query anywhere in the application that
mentions a tenant.

The isolation is Postgres's: `users` and `orders` each carry a `tenantId`, each has
a row-level-security policy comparing it to a session variable, and the application
sets that variable at the start of every transaction. A statement that forgets the
tenant does not return the wrong rows — it returns none, and a write that forgets it
is refused.

## Why not `where: { tenantId }`

Because that version cannot be reviewed. "Every query filters by tenant" is a
property of several hundred call sites, each one clause away from serving another
customer's rows, and nothing in a diff, a type or a test run tells you which ones
are missing it. The failure is silent, it is in the direction of disclosure, and it
is found by a customer.

A policy is one statement per table that the planner adds to everything anybody
writes — including the queries nobody has written yet, the ORM's own lookups, and
the `UPDATE` somebody runs in psql under the application's role at 2am. The question
changes from "did every author remember?" to "is the policy on the table?", which is
one query to answer and `RlsEnforcementService` answers it at every boot.

## The pieces

| Where                                                              | What                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `prisma/migrations/20261002000000_add_multi_tenancy/migration.sql` | `tenants`, the `tenantId` columns, `current_tenant_id()`, `require_tenant_id()`, the policies |
| `prisma/rls/app-role.sql`                                          | the database role the policies actually apply to                                              |
| `src/tenancy/tenant-context.ts`                                    | the tenant in scope, in an `AsyncLocalStorage`                                                |
| `src/tenancy/tenant.resolver.ts`                                   | host or header → tenant, with no database round trip                                          |
| `src/tenancy/tenant-context.middleware.ts`                         | puts the request's tenant in scope for everything downstream                                  |
| `src/tenancy/tenant-prisma.ts`                                     | `set_config` per transaction, and the client extension that wraps every read in one           |
| `src/tenancy/tenant.guard.ts`                                      | a token may not be used in another tenant                                                     |
| `src/tenancy/rls-enforcement.service.ts`                           | the boot-time check that any of this is in force                                              |

## How a request gets its tenant

`tenantContextMiddleware` resolves it from two places and nothing else:

- **The host**, when `TENANCY_BASE_DOMAIN` is set: `acme.api.example.com` under
  `api.example.com` is tenant `acme`. One label only, and a label that is not a
  usable id (`www`, the apex itself) resolves to nobody rather than to an error —
  a deployment behind a base domain still has to answer on its other names.
- **`X-Tenant-Id`**, unless `TENANCY_TRUST_HEADER=false`.

If both speak and disagree, the request is refused: the host is what DNS and the
ingress decided and the header is what the client asked for, and a request where
they differ is a misconfigured gateway or somebody probing for which one wins.
Neither of them is _authorisation_ — naming a tenant is not being allowed into it.
Authentication still has to succeed against that tenant's users, the access token
carries the tenant it was issued for, and the policies refuse whatever gets past
both.

With nothing to go on, the tenant is `TENANCY_DEFAULT_TENANT_ID` — `default`, the
row the migration inserts. That is what makes a single-tenant deployment work with
no tenancy configuration at all, and it is why there is no `TENANCY_ENABLED` flag:
one tenant is multi-tenancy with one tenant, and a feature that is off in
development is a feature nothing tests.

Resolution does no database lookup, which is the reason `tenants.id` is the slug
rather than a surrogate key. The alternative puts a round trip, a cache and a
staleness window on the path that decides which customer's data a request may see —
and a _failure mode_ there too: a resolver that cannot answer either rejects a
legitimate request or guesses. Nothing asserts that the tenant exists, because the
foreign key and the policies already do: an unknown tenant reads nothing and cannot
write.

## How the tenant reaches Postgres

`app.current_tenant_id` is a custom GUC, set with `set_config(…, true)` —
transaction-local. Three decisions in that one statement:

- **`set_config`, not `SET LOCAL`.** `SET` takes no parameters, so the value would
  have to be interpolated into SQL — and the value came from a `Host` header.
- **Transaction-local, not session-level.** A session-level setting outlives the
  request, and behind a connection pool the next request handed that connection
  would inherit the previous tenant. That is the worst failure this feature exists
  to prevent and it only appears under concurrency.
- **Inside a transaction, therefore.** Outside one, every statement is its own
  transaction and a transaction-local setting is gone before the next statement
  runs.

Two places issue it:

1. **`PrismaTransactionRunner`**, as the first statement of every transaction. This
   is what makes every existing write path tenant-correct without a single adapter
   mentioning a tenant: the `tenantId` columns default to `require_tenant_id()`, so
   the row gets its tenant from the transaction.
2. **`tenantScopeExtension`**, for reads outside a transaction. Each model operation
   becomes a two-statement batch — the setting, then the query — because
   `$transaction([…])` is what guarantees both run on one connection inside one
   transaction. `PrismaService.withExtensions()` applies it, and
   `PrismaUsersRepository` and `PrismaOrderStore` read through it.

That batch is one extra round trip per read. It is the honest price of isolation the
database enforces rather than the application remembering to, and
`test/orders-read.db-spec.ts` pins the cost: one statement per _operation_, never
per row.

### The alternative: a pool per tenant

Postgres accepts GUCs in the connection string:

```
postgresql://app:…@host/db?options=-c%20app.current_tenant_id%3Dacme
```

Every statement on that connection is scoped with no extra round trip, which is
right for a single-tenant deployment and for a worker that serves one tenant for
its lifetime. It is wrong — dangerously so — for a pool shared between tenants, and
it is what `test/helpers/db.ts` uses for the suites that are about something else.
`test/tenant-isolation.db-spec.ts` covers both arrangements.

## Work that is not a request

Every HTTP request has a tenant. Anything else has to say which tenant it is acting
for:

```ts
await runInTenant(job.tenantId, () => this.orders.find(job.orderId));
```

`runInTenant` validates the id (it reaches `set_config`, and it came from a job
payload), scopes the callback, and restores whatever was in scope before.
`enterTenant` is the same thing for a context that _is_ the unit of work and has no
callback to nest in, and `outsideAnyTenant` is how a genuinely tenant-less pass
drops a tenant it inherited.

A tenant-scoped read with nothing in scope throws `MissingTenantContextError` rather
than returning nothing: the two ways of being wrong are not symmetrical, and a stack
trace pointing at the caller that forgot is worth more than an empty array.

One wrinkle worth knowing: Prisma's promises are lazy, so the tenant is read when an
operation _runs_, not when it is built. An operation created inside a scope and
awaited outside it is refused — fail-closed, and the reason every read in
`PrismaUsersRepository` awaits inside its own method rather than handing the caller a
promise to await later.

## The token

Access tokens carry `tid`, the tenant they were issued for — the tenant the request
was addressing, not a property of the user row (that row was only visible because
the policies allowed this tenant to see it). `TenantGuard` refuses a token presented
against any other tenant with a 403.

Without that check the request would be _safe_ and unreadable: the user id in the
token names a row the policies will not show, so reads come back empty and writes
fail a foreign key. A 403 naming both tenants is the difference between a minute and
an afternoon.

A token with no `tid` is refused. Tokens minted before this change verify perfectly
and name no customer, and defaulting them into one would mean a credential whose
scope this service chose for it. Access tokens live fifteen minutes, so an upgrade
costs at most one refresh per client — the refresh token is opaque and still works.

## The role, which is the part that is easy to get wrong

**A policy is not evaluated for a superuser, or for a role with `BYPASSRLS`.**
`ALTER TABLE … FORCE ROW LEVEL SECURITY` removes the _owner's_ exemption, not
theirs. So the most likely way to deploy this application with no isolation at all
is to deploy it entirely correctly and connect as `postgres` — which is what every
quickstart, compose file and CI service container hands you. Everything works,
every tenant sees its own rows, and the isolation is one injection or one forgotten
clause away from being absent.

So:

```bash
pnpm db:migrate:prod                       # as the owner
psql "$ADMIN_DATABASE_URL" \
  -v app_role=app_user \
  -v app_password="$APP_DB_PASSWORD" \
  -f prisma/rls/app-role.sql               # once per database
# then point DATABASE_URL at app_user
```

`RlsEnforcementService` checks at every boot that the connected role does not bypass
the policies and that every tenant-owned table has them enabled _and_ forced. In
production a failure refuses to boot. Everywhere else it is a warning, because a
development machine and the CI service container both run as the superuser they were
created with, and refusing there would mean provisioning a role before you could run
anything. The check is skipped under `NODE_ENV=test`, where the application runs
against an in-memory double with no `pg_roles` to ask —
`test/tenant-isolation.db-spec.ts` asks a real one, as a real non-superuser role.

## Which tables are covered, and why the rest are not

`users`, `orders` and `tenants` have policies. The others do not, and the list is a
decision rather than an oversight:

- **`outbox_events`, `saga_instances`** are claimed by background pollers that run
  under no request and must see every tenant's rows. A policy would stop the relay
  dead; a `tenantId` column with a raising default would stop it being written.
- **`audit_log`** is a hash chain over every entry in the deployment. Filtering it
  per tenant would make `AuditChainVerifier` report a broken chain to every reader,
  because the entry before the first visible one would be invisible.
- **`refresh_tokens`, `refresh_token_families`** are keyed by an unguessable secret
  and are read _before_ the request is authenticated, so there is no authenticated
  tenant to compare against yet. The check happens one step later, when the token's
  user is loaded through a policy-covered read of `users`.

Each of those is reached only through code that already holds the tenant it needs —
an event payload, a saga's state, an audit entry's actor. If you decide otherwise:
add the column with `@default(dbgenerated("require_tenant_id()"))`, add
`ENABLE`/`FORCE ROW LEVEL SECURITY` and a policy in the same shape as the two the
migration writes, add the table to `TENANT_SCOPED_TABLES`, and check what reads it
outside a request. `prisma/rls/app-role.sql` warns about any table that has a
`tenantId` column and no enforced policy, which catches the half of the mistake that
is easy to make.

## Adding a tenant

Provisioning is an operator action, deliberately: `tenants` has a read policy and no
write policy, so a request cannot create one.

```sql
INSERT INTO tenants (id, name, "createdAt", "updatedAt")
VALUES ('acme', 'Acme Ltd', now(), now());
```

The id is a slug — two to 63 lower-case characters, the same `CHECK` constraint the
table carries and the same expression `isTenantId` tests, because it has to work as
a DNS label and as a header value. Renaming one is possible (the foreign keys are
`ON UPDATE CASCADE`) but it invalidates every issued access token and every URL that
named the old slug.

Deleting one is refused while it still owns rows (`ON DELETE RESTRICT`). Removing a
customer is a retention decision with an order of operations, not one statement with
no way back.

## One identity, one tenant

`users.email` stays globally unique, so an account belongs to exactly one tenant and
an invitation to a second organisation is a second account. That is the model most
B2B products want, and it keeps the login path simple.

Uniqueness does not make a row visible: an address registered in another tenant is
simply not found, rather than found and then checked — `test/tenant-isolation.db-spec.ts`
pins that, because it is the one place where a global constraint and a per-tenant
policy could have disagreed.

The other design is `@@unique([tenantId, email])`, one person with accounts in
several tenants. It is a real design and it costs two reads: `findByEmail` has to
name the tenant it is authenticating against before it can look the address up at
all (`findUnique({ where: { tenantId_email: … } })`), and so does the OAuth
account-linking path. The policies and everything above are unchanged.

## Configuration

| Variable                    | Default   | What it does                                                          |
| --------------------------- | --------- | --------------------------------------------------------------------- |
| `TENANCY_DEFAULT_TENANT_ID` | `default` | the tenant a request with nothing to go on belongs to                 |
| `TENANCY_TRUST_HEADER`      | `true`    | whether `X-Tenant-Id` is honoured                                     |
| `TENANCY_BASE_DOMAIN`       | unset     | the domain tenant subdomains hang off; unset disables host resolution |

Turn the header off where tenancy is structural and a client-supplied one could only
ever be a mistake. Leave the base domain unset until the host is genuinely
controlled: with it set, the first label of the `Host` header decides which
customer's data a request sees, and a deployment reachable under more names than its
operator thinks would be resolving tenants from a string an attacker can choose.
