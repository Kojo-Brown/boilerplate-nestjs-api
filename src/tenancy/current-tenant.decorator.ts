import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { requireTenantId } from "./tenant-context";

/**
 * The tenant this request belongs to, for a handler that needs to say it out loud
 * — an audit entry, a log line, a link back to the tenant's own row.
 *
 * It reads the `AsyncLocalStorage` rather than the request object, so a handler
 * and the repository three layers under it cannot disagree about which tenant
 * they are serving. Almost nothing needs it: a tenant-scoped query carries the
 * tenant to Postgres by itself, and a handler that takes this and then filters on
 * it is writing the application-side isolation this feature exists to replace.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): string => requireTenantId("@CurrentTenant()"),
);
