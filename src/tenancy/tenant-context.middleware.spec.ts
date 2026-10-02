import { BadRequestException, Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  TENANT_RESOLUTION_FAILURE,
  applyTenantContext,
  tenantContextMiddleware,
} from "./tenant-context.middleware";
import type { TenantAwareRequest } from "./tenant-context.middleware";
import { currentTenant, currentTenantId } from "./tenant-context";
import { TENANT_HEADER } from "./tenancy.env";
import type { TenancyEnv } from "./tenancy.env";

const env: TenancyEnv = {
  TENANCY_DEFAULT_TENANT_ID: "default",
  TENANCY_TRUST_HEADER: true,
  TENANCY_BASE_DOMAIN: "api.example.com",
};

function requestWith(headers: Record<string, string | string[]>): TenantAwareRequest {
  return { headers } as unknown as TenantAwareRequest;
}

const noResponse = {} as Response;

describe("applyTenantContext", () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("binds the middleware for every route, before anything else looks at a request", () => {
    // `app.use` rather than a `MiddlewareConsumer` registration, the same arrangement
    // `applySecurity` uses: one binding for every route including the ones no
    // controller declares, with no route pattern to keep in step with Express's
    // matcher.
    const app = { use: jest.fn() } as unknown as INestApplication;

    applyTenantContext(app, env);

    expect(app.use).toHaveBeenCalledTimes(1);
    expect(app.use).toHaveBeenCalledWith(expect.any(Function));
  });

  it("says at boot what it will resolve tenants from", () => {
    // Which deployment this is — one tenant, a header, a base domain — is the first
    // thing somebody reading a boot log for a tenancy problem wants to know.
    applyTenantContext({ use: () => undefined } as unknown as INestApplication, env);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('default "default"') as unknown as string,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("X-Tenant-Id honoured"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("*.api.example.com"));
  });

  it("says so when the header is ignored and no base domain is configured", () => {
    applyTenantContext({ use: () => undefined } as unknown as INestApplication, {
      ...env,
      TENANCY_TRUST_HEADER: false,
      TENANCY_BASE_DOMAIN: undefined,
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("X-Tenant-Id ignored"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("host-based resolution off"));
  });
});

describe("tenantContextMiddleware", () => {
  it("puts the request's tenant in scope for everything downstream", () => {
    const middleware = tenantContextMiddleware(env);
    const req = requestWith({ host: "acme.api.example.com" });
    let seen: unknown;

    middleware(req as Request, noResponse, (() => {
      seen = currentTenant();
    }) as NextFunction);

    expect(seen).toEqual({ tenantId: "acme", source: "host" });
  });

  it("keeps the tenant in scope across the awaits the rest of the request makes", async () => {
    // The reason this is middleware and not a guard: `next()` is called *inside*
    // the context, so everything the request goes on to do inherits it — including
    // the repository three layers down that issues the statement.
    const middleware = tenantContextMiddleware(env);
    let seen: string | undefined;

    await new Promise<void>((resolve) => {
      middleware(requestWith({ [TENANT_HEADER]: "globex" }) as Request, noResponse, (async () => {
        await new Promise((tick) => setImmediate(tick));
        seen = currentTenantId();
        resolve();
      }) as unknown as NextFunction);
    });

    expect(seen).toBe("globex");
  });

  it("leaves no tenant in scope once the request has been handed on", () => {
    const middleware = tenantContextMiddleware(env);

    middleware(requestWith({}) as Request, noResponse, (() => undefined) as NextFunction);

    expect(currentTenantId()).toBeUndefined();
  });

  describe("when the tenant cannot be resolved", () => {
    const middleware = tenantContextMiddleware(env);

    it("records the failure on the request instead of throwing", () => {
      // A middleware that threw would reach Express's own error handler, which
      // answers with an HTML stack trace and never consults
      // `AllExceptionsFilter` — so the client would get a 500 in a shape nothing
      // else in this API produces.
      const req = requestWith({ [TENANT_HEADER]: "Acme Corp" });
      const next = jest.fn();

      expect(() => middleware(req as Request, noResponse, next as NextFunction)).not.toThrow();

      expect(next).toHaveBeenCalledTimes(1);
      expect(req[TENANT_RESOLUTION_FAILURE]).toBeInstanceOf(BadRequestException);
    });

    it("does not fall back to the default tenant", () => {
      // Falling back would serve the default tenant's data to a request that asked
      // for another one. With no tenant in scope every statement fails closed and
      // `TenantGuard` turns the recorded failure into the 400 it is.
      const req = requestWith({ [TENANT_HEADER]: "Acme Corp" });
      let seen: string | undefined = "not read yet";

      middleware(req as Request, noResponse, (() => {
        seen = currentTenantId();
      }) as NextFunction);

      expect(seen).toBeUndefined();
    });
  });
});
