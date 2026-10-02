import { BadRequestException, ExecutionContext, ForbiddenException } from "@nestjs/common";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { TenantGuard } from "./tenant.guard";
import { TENANT_RESOLUTION_FAILURE } from "./tenant-context.middleware";
import { runInTenant } from "./tenant-context";

interface FakeRequest {
  user?: AuthenticatedUser;
  [TENANT_RESOLUTION_FAILURE]?: Error;
}

function httpContext(req: FakeRequest): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const tokenFor = (tenantId: string): AuthenticatedUser => ({
  id: "user-1",
  email: "person@example.test",
  role: "USER",
  tenantId,
});

describe("TenantGuard", () => {
  const guard = new TenantGuard();

  it("passes a request whose token was issued for the tenant it is addressing", () => {
    const allowed = runInTenant("acme", () =>
      guard.canActivate(httpContext({ user: tokenFor("acme") })),
    );

    expect(allowed).toBe(true);
  });

  it("passes a request with no authenticated user", () => {
    // A public route — login, register, the health check. The request's own tenant
    // is all there is to go on and there is nothing to cross-check it against.
    const allowed = runInTenant("acme", () => guard.canActivate(httpContext({})));

    expect(allowed).toBe(true);
  });

  it("refuses a token issued for another tenant", () => {
    // Safe without this check and unreadable: the user id in the token belongs to
    // a row the policies will not show, so every read comes back empty and every
    // write fails a foreign key. A 403 naming both tenants is the difference
    // between a minute and an afternoon.
    expect(() =>
      runInTenant("globex", () => guard.canActivate(httpContext({ user: tokenFor("acme") }))),
    ).toThrow(ForbiddenException);
  });

  it("names both tenants in the refusal", () => {
    try {
      runInTenant("globex", () => guard.canActivate(httpContext({ user: tokenFor("acme") })));
      fail("expected the guard to refuse");
    } catch (caught: unknown) {
      expect((caught as Error).message).toContain("acme");
      expect((caught as Error).message).toContain("globex");
    }
  });

  it("refuses an authenticated request with no tenant in scope at all", () => {
    expect(() => guard.canActivate(httpContext({ user: tokenFor("acme") }))).toThrow(
      ForbiddenException,
    );
  });

  it("rethrows a resolution failure the middleware recorded", () => {
    // This is where a malformed `X-Tenant-Id` becomes a 400 with the same envelope
    // and correlation id as every other 4xx — the middleware could not throw it
    // itself without bypassing `AllExceptionsFilter`.
    const failure = new BadRequestException("not a tenant id");

    expect(() => guard.canActivate(httpContext({ [TENANT_RESOLUTION_FAILURE]: failure }))).toThrow(
      failure,
    );
  });

  it("rethrows the resolution failure before looking at the token", () => {
    // Order matters: a request whose tenant could not be resolved has nothing to
    // compare the token against, and 403 would be the wrong answer to "that is
    // not a tenant id".
    const failure = new BadRequestException("not a tenant id");

    expect(() =>
      runInTenant("acme", () =>
        guard.canActivate(
          httpContext({ user: tokenFor("globex"), [TENANT_RESOLUTION_FAILURE]: failure }),
        ),
      ),
    ).toThrow(failure);
  });

  it("passes a non-HTTP execution context", () => {
    // A gateway has no Express request and no middleware to have run.
    // `RealtimeGateway` authenticates its own handshake, including the tenant
    // claim, in `authenticateHandshake`.
    const ws = { getType: () => "ws" } as unknown as ExecutionContext;

    expect(guard.canActivate(ws)).toBe(true);
  });
});
