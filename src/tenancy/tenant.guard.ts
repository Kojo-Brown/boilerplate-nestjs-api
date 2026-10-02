import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { currentTenantId } from "./tenant-context";
import { TENANT_RESOLUTION_FAILURE } from "./tenant-context.middleware";
import type { TenantAwareRequest } from "./tenant-context.middleware";

/**
 * The two checks that settle which tenant a request is acting as.
 *
 * **A resolution failure becomes a response.** `tenantContextMiddleware` cannot
 * throw — a middleware's exception never reaches `AllExceptionsFilter` — so it
 * records the failure and this rethrows it from inside the pipeline, where it
 * gets the same error envelope and correlation id as every other 4xx.
 *
 * **A token may not be used in another tenant.** The access token carries the
 * tenant it was issued for in `tid`; the request names a tenant through its host
 * or its header. A token from one tenant presented against another is refused
 * here rather than being allowed to proceed on the strength of the policies
 * alone: with a mismatch the user id in the token belongs to a row the policies
 * will not show, so every read returns empty and every write fails a foreign key
 * — technically safe, and indistinguishable from a bug for whoever has to
 * diagnose it. A 403 that names the two tenants is the difference between an
 * afternoon and a minute.
 *
 * Registered after `JwtAuthGuard`, which is what puts `req.user` there. The cost
 * of that order is that a malformed `X-Tenant-Id` on a request with no valid
 * token answers 401 before it answers 400, which is the right way round: an
 * unauthenticated caller learns nothing about this deployment's tenancy.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Gateways and any future non-HTTP transport have no Express request to read
    // and no middleware to have run. `RealtimeGateway` fans out domain events and
    // touches no tenant-owned table; a transport that did would need its own
    // place to establish the context, not an exemption here.
    if (context.getType() !== "http") return true;

    const req = context
      .switchToHttp()
      .getRequest<TenantAwareRequest & { user?: AuthenticatedUser }>();

    const failure = req[TENANT_RESOLUTION_FAILURE];
    if (failure !== undefined) throw failure;

    const user = req.user;
    // No authenticated user: a public route, where the request's own tenant is
    // all there is to go on. Nothing to cross-check.
    if (user === undefined) return true;

    const scope = currentTenantId();
    if (user.tenantId !== scope) {
      throw new ForbiddenException(
        `This access token was issued for tenant "${user.tenantId}" and the request names ` +
          `${scope === undefined ? "no tenant" : `"${scope}"`}. Authenticate against the tenant ` +
          `you are addressing.`,
      );
    }

    return true;
  }
}
