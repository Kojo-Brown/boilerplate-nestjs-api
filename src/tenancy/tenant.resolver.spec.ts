import { BadRequestException } from "@nestjs/common";
import { resolveTenant } from "./tenant.resolver";
import { TENANT_HEADER } from "./tenancy.env";
import type { TenancyEnv } from "./tenancy.env";

const defaults: TenancyEnv = {
  TENANCY_DEFAULT_TENANT_ID: "default",
  TENANCY_TRUST_HEADER: true,
  TENANCY_BASE_DOMAIN: undefined,
};

const env = (overrides: Partial<TenancyEnv> = {}): TenancyEnv => ({ ...defaults, ...overrides });

describe("resolveTenant", () => {
  describe("with nothing to go on", () => {
    it("resolves the configured default, which is what a single-tenant deployment is", () => {
      expect(resolveTenant({}, env())).toEqual({ tenantId: "default", source: "default" });
    });

    it("treats an empty header as absent rather than as a malformed id", () => {
      // A proxy that always sets the header and sometimes has nothing to put in
      // it is an ordinary deployment, not a client error.
      expect(resolveTenant({ [TENANT_HEADER]: "   " }, env())).toEqual({
        tenantId: "default",
        source: "default",
      });
    });
  });

  describe("from the header", () => {
    it("resolves the tenant it names", () => {
      expect(resolveTenant({ [TENANT_HEADER]: "acme" }, env())).toEqual({
        tenantId: "acme",
        source: "header",
      });
    });

    it("trims it, because a copied value arrives with whitespace", () => {
      expect(resolveTenant({ [TENANT_HEADER]: " acme " }, env())).toMatchObject({
        tenantId: "acme",
      });
    });

    it("ignores it entirely when the deployment does not trust it", () => {
      expect(
        resolveTenant({ [TENANT_HEADER]: "acme" }, env({ TENANCY_TRUST_HEADER: false })),
      ).toEqual({ tenantId: "default", source: "default" });
    });

    it("refuses a value that is not a tenant id", () => {
      // Not the default tenant: a client that asked for something this system
      // cannot mean must not be quietly served somebody else's data.
      expect(() => resolveTenant({ [TENANT_HEADER]: "Acme Corp" }, env())).toThrow(
        BadRequestException,
      );
    });

    it("refuses a repeated header rather than picking one", () => {
      expect(() => resolveTenant({ [TENANT_HEADER]: ["acme", "globex"] }, env())).toThrow(
        BadRequestException,
      );
    });
  });

  describe("from the host", () => {
    const withDomain = env({ TENANCY_BASE_DOMAIN: "api.example.com" });

    it("resolves the first label under the base domain", () => {
      expect(resolveTenant({ host: "acme.api.example.com" }, withDomain)).toEqual({
        tenantId: "acme",
        source: "host",
      });
    });

    it("strips the port, which Host carries on any non-default listener", () => {
      expect(resolveTenant({ host: "acme.api.example.com:4000" }, withDomain)).toMatchObject({
        tenantId: "acme",
      });
    });

    it("lower-cases it, because a hostname does not distinguish case", () => {
      expect(resolveTenant({ host: "ACME.api.example.com" }, withDomain)).toMatchObject({
        tenantId: "acme",
      });
    });

    it("resolves nobody for the apex itself", () => {
      expect(resolveTenant({ host: "api.example.com" }, withDomain)).toEqual({
        tenantId: "default",
        source: "default",
      });
    });

    it("resolves nobody for a host that merely contains the base domain", () => {
      // `acme.api.example.com.evil.test` ends with neither `.api.example.com` nor
      // anything this deployment serves, and reading a tenant out of it would let
      // whoever controls that zone choose one.
      expect(resolveTenant({ host: "acme.api.example.com.evil.test" }, withDomain)).toMatchObject({
        source: "default",
      });
    });

    it("refuses to read a tenant out of more than one label", () => {
      // A tenant id cannot contain a dot, so `a.b` is not a tenant — and anybody
      // who can add a CNAME must not be able to invent one.
      expect(resolveTenant({ host: "a.b.api.example.com" }, withDomain)).toMatchObject({
        source: "default",
      });
    });

    it("resolves nobody for a label that is not a usable id", () => {
      // The apex, `www`, a health-check hostname: a deployment behind a base
      // domain still answers on all of them, and those requests are the default
      // tenant's rather than an error.
      expect(resolveTenant({ host: "w.api.example.com" }, withDomain)).toMatchObject({
        source: "default",
      });
    });

    it("leaves an IPv6 literal alone instead of reading a port off it", () => {
      expect(resolveTenant({ host: "[::1]:4000" }, withDomain)).toMatchObject({
        source: "default",
      });
    });

    it("ignores the host entirely when no base domain is configured", () => {
      expect(resolveTenant({ host: "acme.api.example.com" }, env())).toMatchObject({
        source: "default",
      });
    });
  });

  describe("when both sources speak", () => {
    const withDomain = env({ TENANCY_BASE_DOMAIN: "api.example.com" });

    it("accepts them when they agree", () => {
      expect(
        resolveTenant({ host: "acme.api.example.com", [TENANT_HEADER]: "acme" }, withDomain),
      ).toEqual({ tenantId: "acme", source: "host" });
    });

    it("refuses them when they disagree, rather than preferring one", () => {
      // The two mean different things — what DNS decided, and what the client
      // asked for — and a request where they disagree is a misconfigured gateway
      // or somebody probing for which one wins.
      expect(() =>
        resolveTenant({ host: "acme.api.example.com", [TENANT_HEADER]: "globex" }, withDomain),
      ).toThrow(BadRequestException);
    });

    it("ignores a disagreeing header when the deployment does not trust headers", () => {
      expect(
        resolveTenant(
          { host: "acme.api.example.com", [TENANT_HEADER]: "globex" },
          env({ TENANCY_BASE_DOMAIN: "api.example.com", TENANCY_TRUST_HEADER: false }),
        ),
      ).toMatchObject({ tenantId: "acme" });
    });
  });
});
