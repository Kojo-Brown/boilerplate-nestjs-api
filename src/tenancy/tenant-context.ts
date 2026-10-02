import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The tenant whose data the currently running code is allowed to touch.
 *
 * Carried in an `AsyncLocalStorage` rather than passed as an argument, for the
 * same reason `currentLock()` is (see `src/common/locking/lock-session.ts`): the
 * alternative is a `tenantId` parameter threaded through every controller,
 * command handler, repository method and Prisma call in the application, and a
 * parameter that has to be added to two hundred signatures is a parameter
 * somebody will forget to pass. Here there is exactly one place it is set per
 * request — `tenantContextMiddleware` — and one place it is read per statement.
 *
 * It is deliberately *not* the only line of defence. Everything this file does
 * is in the application's own memory, and an application-side filter is exactly
 * the thing that cannot be audited: what makes a missing tenant safe rather than
 * catastrophic is that the database refuses the statement
 * (`20261002000000_add_multi_tenancy`). This is how the tenant reaches the
 * database, not what enforces it.
 */
export interface TenantContext {
  readonly tenantId: string;
  /** Where the tenant was resolved from, for the access log and for diagnostics. */
  readonly source: TenantSource;
}

export type TenantSource = "host" | "header" | "default" | "explicit";

/**
 * The shape a tenant id has to have.
 *
 * It is a slug because it arrives in a `Host` header or an `X-Tenant-Id` header
 * and is compared straight against a column — see the `Tenant` model for the
 * trade that buys. Lower case only: a hostname is case-insensitive, so `Acme`
 * and `acme` are one tenant to DNS and would be two rows here. The same
 * expression is a `CHECK` constraint on `tenants.id`, so a value that got past
 * this one still could not be stored.
 *
 * Two to 63 characters: the upper bound is the maximum length of a DNS label, and
 * a tenant whose slug cannot be a subdomain cannot be routed to. The lower bound
 * falls out of requiring the first and last character to be alphanumeric, which is
 * what keeps `-acme` and `acme-` out.
 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export function isTenantId(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}

/**
 * Thrown when code that needs a tenant runs with none in scope.
 *
 * This is a programming error rather than a request error: every HTTP request
 * passes through the middleware that sets the context, so reaching a
 * tenant-scoped read without one means the work is happening somewhere else — a
 * queue worker, a poller, a script — and that caller has to say which tenant it
 * is acting for by wrapping itself in {@link runInTenant}.
 *
 * It mirrors `require_tenant_id()`'s refusal in SQL, and for the same reason: the
 * alternative to failing is attributing data to whichever tenant happens to be
 * convenient.
 */
export class MissingTenantContextError extends Error {
  constructor(what: string) {
    super(
      `${what} ran with no tenant in scope. Every HTTP request is given one by ` +
        `tenantContextMiddleware; work that starts anywhere else — a queue job, a poller, a ` +
        `script — has to name the tenant it is acting for with runInTenant(tenantId, …).`,
    );
    this.name = "MissingTenantContextError";
  }
}

const storage = new AsyncLocalStorage<TenantContext>();

/** The tenant in scope, or `undefined` outside one. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** The tenant id in scope, or `undefined` outside one. */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * The tenant id in scope, or a thrown {@link MissingTenantContextError}.
 *
 * `what` names the caller, because the stack trace of an async continuation
 * three frames inside Prisma says nothing about which read it was.
 */
export function requireTenantId(what: string): string {
  const tenantId = currentTenantId();
  if (tenantId === undefined) throw new MissingTenantContextError(what);
  return tenantId;
}

/**
 * Runs `work` with `tenantId` in scope, restoring whatever was in scope before.
 *
 * This is the entry point for everything that is not an HTTP request: a BullMQ
 * processor acting on behalf of the tenant whose job it took, a migration
 * script, a test. The id is validated rather than trusted, because a value that
 * reaches `set_config` unvalidated is a value chosen by whatever produced the
 * job payload.
 */
export function runInTenant<T>(tenantId: string, work: () => T): T {
  if (!isTenantId(tenantId)) {
    throw new TypeError(
      `"${tenantId}" is not a usable tenant id: it has to match ${String(TENANT_ID_PATTERN)}, ` +
        `which is also the CHECK constraint on tenants.id.`,
    );
  }
  return storage.run({ tenantId, source: "explicit" }, work);
}

/**
 * Runs `work` with no tenant in scope at all, whatever was in scope before.
 *
 * The counterpart of {@link runInTenant}, and not a convenience: without it there
 * is no way to express "this work has no tenant" from inside a context that has
 * one, so nothing could test what the tenant-scoped paths do when they are reached
 * without one — which is the case that must fail rather than guess.
 *
 * It is also what a background worker wants around work that is genuinely
 * tenant-less (a relay pass, a poller) when it is started from a request.
 */
export function outsideAnyTenant<T>(work: () => T): T {
  return storage.exit(work);
}

/**
 * Puts `tenantId` in scope for the rest of the current execution context, with no
 * callback to nest the work inside.
 *
 * `AsyncLocalStorage.enterWith` rather than `run`, and the difference matters:
 * there is no scope to leave, so the tenant stays set for everything the current
 * context goes on to do. That is wrong for a request — two requests share a
 * process and an id that outlives its request is the leak this whole feature
 * exists to prevent — and right for a context that *is* the unit of work: a queue
 * processor that has just taken a job, a one-shot script, a test's `beforeEach`.
 *
 * Prefer {@link runInTenant} wherever the work has a boundary. This exists for
 * where it does not — and a test hook is **not** one of those places: a hook's
 * execution context is not reliably an ancestor of the test's, so a tenant entered in
 * `beforeEach` can be gone by the time the body runs. Wrap the body instead; the
 * specs that need one do.
 */
export function enterTenant(tenantId: string): void {
  if (!isTenantId(tenantId)) {
    throw new TypeError(
      `"${tenantId}" is not a usable tenant id: it has to match ${String(TENANT_ID_PATTERN)}, ` +
        `which is also the CHECK constraint on tenants.id.`,
    );
  }
  storage.enterWith({ tenantId, source: "explicit" });
}

/**
 * Runs `work` in an already-resolved context.
 *
 * Used by the middleware, which has decided both the id and where it came from
 * and has already validated it. Everything else should use {@link runInTenant}.
 */
export function runInTenantContext<T>(context: TenantContext, work: () => T): T {
  return storage.run(context, work);
}
