import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { resolveTenant } from "./tenant.resolver";
import { runInTenantContext } from "./tenant-context";
import type { TenancyEnv } from "./tenancy.env";

/**
 * Where a resolution failure is parked until something inside Nest can throw it.
 *
 * A middleware runs outside the request pipeline: an exception thrown here goes
 * to Express's own error handler, which answers with an HTML stack trace and
 * never reaches `AllExceptionsFilter`, so the client gets a 500 in a shape
 * nothing else in this API produces. Resolution therefore records the failure and
 * lets `TenantGuard` — which runs inside the pipeline, where filters, the
 * response envelope and the correlation id all apply — rethrow it.
 *
 * A symbol rather than a property name, because this hangs off the Express
 * request object, which is shared with every other middleware in the process.
 */
export const TENANT_RESOLUTION_FAILURE = Symbol("tenant.resolutionFailure");

export interface TenantAwareRequest extends Request {
  [TENANT_RESOLUTION_FAILURE]?: Error;
}

/**
 * Puts the request's tenant in scope for everything the request goes on to do.
 *
 * This is middleware rather than a guard or an interceptor, and it has to be:
 * only a middleware can *wrap* the rest of the request
 * (`runInTenantContext(ctx, next)`), and only a middleware runs before the
 * guards. Authentication, rate limiting and every handler below them read the
 * tenant, so a mechanism that ran after the guards would be too late — and a
 * guard cannot establish an `AsyncLocalStorage` scope at all, because its own
 * frame has returned by the time the handler runs.
 *
 * A failed resolution does **not** fall back to the default tenant. The context
 * is left unset, so any database access fails closed, and `TenantGuard` turns the
 * recorded failure into the 400 it is.
 */
export function tenantContextMiddleware(env: TenancyEnv): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    let context;
    try {
      context = resolveTenant(req.headers, env);
    } catch (caught: unknown) {
      // Normalised to an `Error` here rather than at the throw site, so the guard
      // that rethrows it needs no cast and cannot be handed something unthrowable.
      // An `HttpException` passes through untouched and keeps its status; anything
      // else is a bug in resolution and deserves the 500 the filter will give it.
      (req as TenantAwareRequest)[TENANT_RESOLUTION_FAILURE] =
        caught instanceof Error ? caught : new Error(String(caught));
      next();
      return;
    }

    runInTenantContext(context, next);
  };
}

/**
 * Installs the tenant context on an application.
 *
 * Called from `main.ts` and mirrored in `test/helpers/create-test-app.ts`, the
 * same arrangement `applySecurity` uses: `app.use` rather than a
 * `MiddlewareConsumer` registration, so the middleware is bound once for every
 * route — including the ones no controller declares, like the Swagger UI — with
 * no route pattern to keep in step with Express's matcher.
 */
export function applyTenantContext(app: INestApplication, env: TenancyEnv): void {
  app.use(tenantContextMiddleware(env));

  new Logger("Tenancy").log(
    `Tenant context installed: default "${env.TENANCY_DEFAULT_TENANT_ID}"` +
      `, ${env.TENANCY_TRUST_HEADER ? "X-Tenant-Id honoured" : "X-Tenant-Id ignored"}` +
      `, ${
        env.TENANCY_BASE_DOMAIN === undefined
          ? "host-based resolution off"
          : `tenants resolved from *.${env.TENANCY_BASE_DOMAIN}`
      }`,
  );
}
