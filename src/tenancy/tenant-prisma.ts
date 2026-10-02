import { Prisma } from "@prisma/client";
import { currentTenantId, requireTenantId } from "./tenant-context";

/**
 * The session variable the policies read. One constant, because the name appears
 * in SQL (`current_tenant_id()`), in this file, and in every operator runbook
 * that has to reproduce what the application does.
 */
export const TENANT_SETTING = "app.current_tenant_id";

/**
 * `set_config(…, true)` — the tenant, for the length of the current transaction
 * and no longer.
 *
 * Three things about this statement are load-bearing:
 *
 * **`set_config` rather than `SET LOCAL`.** `SET` takes no parameters: the value
 * has to be interpolated into the statement text, which puts a string that came
 * from a `Host` header into SQL. `set_config` is an ordinary function, so the
 * tenant travels as a bound parameter and the question of escaping does not
 * arise. (`isTenantId` would have rejected anything dangerous, but a defence that
 * depends on a regular expression somewhere else is a defence one refactor from
 * being gone.)
 *
 * **`true`, meaning transaction-local.** A session-level `set_config` would
 * outlive the transaction, and behind a connection pool the next request handed
 * that connection would inherit the previous request's tenant — which is the
 * worst failure this whole feature exists to prevent, and one that only shows up
 * under concurrency. Transaction-local is also what makes a pool safe to share
 * between tenants at all.
 *
 * **It has to be inside a transaction to mean anything.** Outside one, Postgres
 * treats every statement as its own transaction, so a transaction-local setting
 * is gone before the next statement runs. That is the reason the extension below
 * wraps each operation in a two-statement batch rather than simply issuing this
 * first.
 */
export function tenantSetting(tenantId: string): Prisma.Sql {
  return Prisma.sql`SELECT set_config(${TENANT_SETTING}, ${tenantId}, TRUE)`;
}

/**
 * The part of a Prisma client this module needs: run a statement, and run a
 * batch of statements on one connection.
 *
 * Declared structurally rather than as `PrismaClient` so that the extension can
 * be built against the pooled client, against a transaction client, or against a
 * double in a unit test — and so that nothing here can reach a model delegate by
 * accident.
 */
export interface TenantBatchClient {
  $executeRaw(query: Prisma.Sql): Prisma.PrismaPromise<number>;
  $transaction(operations: Prisma.PrismaPromise<unknown>[]): Promise<unknown[]>;
}

/**
 * Tells Postgres which tenant an already-open transaction belongs to.
 *
 * Called by `PrismaTransactionRunner` as the first statement of every
 * transaction, which is what makes every existing write path tenant-correct
 * without any adapter knowing that tenancy exists.
 *
 * Returns whether it set anything. A transaction opened with no tenant in scope
 * is *not* an error here, unlike a read through {@link tenantScopeExtension}: the
 * same runner serves the outbox relay and the saga poller, which run under no
 * request, legitimately write only to tables that have no tenant column, and
 * would be stopped dead by a refusal. What they cannot do is touch a
 * tenant-owned table — the policies see a NULL setting, match no row, and the
 * `require_tenant_id()` default refuses the insert.
 */
export async function setTransactionTenant(
  client: Pick<TenantBatchClient, "$executeRaw">,
  tenantId: string | undefined = currentTenantId(),
): Promise<boolean> {
  if (tenantId === undefined) return false;
  await client.$executeRaw(tenantSetting(tenantId));
  return true;
}

/**
 * A Prisma extension that scopes every model operation to the tenant in scope.
 *
 * Each operation becomes a two-statement batch: the setting, then the query.
 * `$transaction([…])` is what guarantees the two run on the same connection and
 * inside one transaction, which is the only arrangement in which a
 * transaction-local setting applies to the statement after it. One extra
 * round-trip pair per query is the honest cost of tenant isolation that the
 * database enforces rather than the application remembering to; a deployment that
 * cannot pay it should give each tenant its own connection pool with the setting
 * in the connection string's `options` instead (docs/multi-tenancy.md).
 *
 * `requireTenantId` rather than a fallback: a read that reaches here with no
 * tenant in scope is a bug in whatever started the work, and the two ways of
 * being wrong are not symmetrical. Refusing is a 500 and a stack trace; guessing
 * is one customer's data in another customer's response.
 *
 * It covers model operations only. `$queryRaw` and `$executeRaw` are deliberately
 * left alone: raw SQL in this codebase is either infrastructure that must not be
 * tenant-scoped (the outbox claim, the advisory lock the audit chain takes) or a
 * statement whose author is holding the tenant themselves. A raw read of a
 * tenant-owned table outside a transaction returns nothing under the policies,
 * which is a visible failure rather than a leak.
 */
export function tenantScopeExtension(client: TenantBatchClient) {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const tenantId = requireTenantId(`${model}.${operation}`);

          const [, result] = await client.$transaction([
            client.$executeRaw(tenantSetting(tenantId)),
            query(args),
          ]);

          // The cast is the batch form's doing: `$transaction([…])` is typed as
          // returning the tuple of its arguments' results, and narrowing that
          // through this structural client type loses which element is which.
          // The value is whatever `query(args)` resolved to, which is the
          // operation's own result type — the signature this callback has to
          // satisfy.
          return result as Awaited<ReturnType<typeof query>>;
        },
      },
    },
  });
}
