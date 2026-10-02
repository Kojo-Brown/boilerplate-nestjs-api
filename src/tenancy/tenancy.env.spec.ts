import { z } from "zod";
import { TENANT_HEADER, refineTenancyEnv, tenancyEnvFrom, tenancyEnvShape } from "./tenancy.env";

/**
 * The tenancy shape on its own, refined exactly as `envSchema` refines it.
 *
 * A local schema rather than the real one, for the reason `security.env.spec.ts`
 * gives: a failing expectation should name the rule under test rather than every
 * unrelated variable a whole environment also has to satisfy.
 */
const schema = z
  .object(tenancyEnvShape)
  .superRefine((env, ctx) => refineTenancyEnv(env, "test", ctx));

const parse = (raw: Record<string, string>) => schema.safeParse(raw);
const messages = (raw: Record<string, string>): string => {
  const result = parse(raw);
  return result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n");
};

describe("the tenancy environment", () => {
  it("boots a single-tenant deployment with nothing configured", () => {
    // The reason there is no `TENANCY_ENABLED`: one tenant is multi-tenancy with
    // one tenant, and a feature that is switched off in development is a feature
    // nothing tests.
    const result = parse({});

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      TENANCY_DEFAULT_TENANT_ID: "default",
      TENANCY_TRUST_HEADER: true,
      TENANCY_BASE_DOMAIN: undefined,
    });
  });

  it("reads the header flag as a boolean, not as the string 'false'", () => {
    // `process.env` values are strings, and `Boolean("false")` is `true` — the
    // mistake that would leave a deployment trusting a header it asked to ignore.
    expect(parse({ TENANCY_TRUST_HEADER: "false" })).toMatchObject({
      data: { TENANCY_TRUST_HEADER: false },
    });
  });

  it("refuses a header flag that is neither true nor false", () => {
    // Not `z.coerce.boolean()`, which makes every non-empty string true — so
    // `TENANCY_TRUST_HEADER=no` would turn on the very thing it asked to turn off.
    expect(parse({ TENANCY_TRUST_HEADER: "yes" }).success).toBe(false);
  });

  it("accepts the boolean it returned, so the settings can be read back", () => {
    // `ConfigModule.forRoot({ validate })` stores what `envSchema` *returned*, and
    // `tenancyEnvFrom` parses that again as a type boundary. Without the
    // `z.boolean()` branch the second parse would reject the value the first one
    // produced — which is a boot failure, in the one code path no unit test of the
    // shape alone would reach.
    expect(parse({ TENANCY_TRUST_HEADER: true as unknown as string })).toMatchObject({
      data: { TENANCY_TRUST_HEADER: true },
    });
  });

  describe("TENANCY_DEFAULT_TENANT_ID", () => {
    it("accepts a slug", () => {
      expect(parse({ TENANCY_DEFAULT_TENANT_ID: "acme-corp" }).success).toBe(true);
    });

    it.each([["Default"], ["de fault"], ["d"], ["default."]])("refuses %p", (value) => {
      // A value the `tenants.id` CHECK constraint would reject is a value that
      // cannot be stored, so every write in the deployment would fail its foreign
      // key — at the first request rather than at boot, if this did not fail here.
      expect(parse({ TENANCY_DEFAULT_TENANT_ID: value }).success).toBe(false);
    });

    it("says why, in terms of the constraint that would have rejected it", () => {
      expect(messages({ TENANCY_DEFAULT_TENANT_ID: "Default" })).toContain("tenants.id");
    });
  });

  describe("TENANCY_BASE_DOMAIN", () => {
    it("accepts a hostname", () => {
      expect(parse({ TENANCY_BASE_DOMAIN: "api.example.com" }).success).toBe(true);
    });

    it("accepts a single label, for a development machine where acme.localhost resolves", () => {
      expect(parse({ TENANCY_BASE_DOMAIN: "localhost" }).success).toBe(true);
    });

    it("refuses a mixed-case domain, which would match no request", () => {
      // `Host` is compared case-insensitively after being lower-cased, so an
      // upper-case character here is a base domain nothing ever ends with.
      expect(parse({ TENANCY_BASE_DOMAIN: "API.example.com" }).success).toBe(false);
    });

    it("refuses surrounding whitespace", () => {
      expect(parse({ TENANCY_BASE_DOMAIN: " api.example.com" }).success).toBe(false);
    });

    it("refuses a leading dot, which would make every host's first label a tenant", () => {
      expect(parse({ TENANCY_BASE_DOMAIN: ".api.example.com" }).success).toBe(false);
    });

    it("refuses a trailing dot", () => {
      expect(parse({ TENANCY_BASE_DOMAIN: "api.example.com." }).success).toBe(false);
    });
  });

  it("is read back from the validated configuration with its defaults intact", () => {
    // `tenancyEnvFrom` exists so the defaults live in one place: a second `?? true`
    // at a call site is a second default, and the one an operator never sees in
    // `.env.example` is the one that wins.
    const config = { get: (key: string) => ({ TENANCY_BASE_DOMAIN: "api.example.com" })[key] };

    expect(tenancyEnvFrom(config)).toEqual({
      TENANCY_DEFAULT_TENANT_ID: "default",
      TENANCY_TRUST_HEADER: true,
      TENANCY_BASE_DOMAIN: "api.example.com",
    });
  });
});

describe("TENANT_HEADER", () => {
  it("is lower case, because that is how Node presents a header name", () => {
    expect(TENANT_HEADER).toBe(TENANT_HEADER.toLowerCase());
  });
});
