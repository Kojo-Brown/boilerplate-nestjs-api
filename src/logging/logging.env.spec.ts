import { loggingEnvSchema, parseExtraAllowlist, readLoggingEnv } from "./logging.env";

describe("logging env", () => {
  describe("LOG_REDACTION_ENABLED", () => {
    /**
     * The opposite default from every optional backend in this codebase, and
     * deliberately so: those are capabilities, and a clean clone should boot
     * with none configured. This is a control.
     */
    it("defaults to on", () => {
      expect(loggingEnvSchema.parse({}).LOG_REDACTION_ENABLED).toBe(true);
    });

    it.each([
      ["false", false],
      ["0", false],
      ["true", true],
      ["1", true],
    ])("reads %p as %p", (raw, expected) => {
      expect(loggingEnvSchema.parse({ LOG_REDACTION_ENABLED: raw }).LOG_REDACTION_ENABLED).toBe(
        expected,
      );
    });

    /**
     * `z.coerce.boolean()` would read "false" as true, so the one spelling an
     * operator reaches for to turn something off would turn it on.
     */
    it("refuses a spelling it does not recognise rather than guessing", () => {
      expect(() => loggingEnvSchema.parse({ LOG_REDACTION_ENABLED: "no" })).toThrow();
    });

    it("is refused in production", () => {
      const result = loggingEnvSchema.safeParse({
        NODE_ENV: "production",
        LOG_REDACTION_ENABLED: "false",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("refused in production");
    });

    it("is allowed off outside production, which is what development is for", () => {
      expect(
        loggingEnvSchema.safeParse({ NODE_ENV: "development", LOG_REDACTION_ENABLED: "false" })
          .success,
      ).toBe(true);
    });
  });

  describe("LOG_REDACTION_EXTRA_ALLOWLIST", () => {
    it("accepts a comma-separated list of patterns", () => {
      expect(
        loggingEnvSchema.safeParse({
          LOG_REDACTION_EXTRA_ALLOWLIST: "order.currency,items[].sku,counts.*",
        }).success,
      ).toBe(true);
    });

    it("refuses a malformed entry rather than dropping it", () => {
      const result = loggingEnvSchema.safeParse({ LOG_REDACTION_EXTRA_ALLOWLIST: "order..id" });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("order..id");
    });

    /**
     * The spelling that would have disabled redaction while reading like
     * configuration, and got around the production refusal above.
     */
    it("refuses a bare wildcard", () => {
      const result = loggingEnvSchema.safeParse({ LOG_REDACTION_EXTRA_ALLOWLIST: "*" });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("may not begin with");
    });

    it("names every bad entry, not only the first", () => {
      const result = loggingEnvSchema.safeParse({
        LOG_REDACTION_EXTRA_ALLOWLIST: "order.currency,a..b,*",
      });
      expect(result.error?.issues).toHaveLength(2);
    });

    describe("parseExtraAllowlist", () => {
      it("trims entries and tolerates a trailing comma", () => {
        expect(parseExtraAllowlist(" order.id , order.currency ,")).toEqual([
          "order.id",
          "order.currency",
        ]);
      });

      it("reads an unset value as an empty list", () => {
        expect(parseExtraAllowlist(undefined)).toEqual([]);
      });
    });
  });

  describe("readLoggingEnv", () => {
    it("reads settings from the environment it is given", () => {
      expect(
        readLoggingEnv({ LOG_REDACTION_ENABLED: "false", NODE_ENV: "test" }).LOG_REDACTION_ENABLED,
      ).toBe(false);
    });

    /**
     * Fails closed. A typo in `LOG_REDACTION_ENABLED` must not disable the
     * control — and throwing from here would replace `envSchema`'s clear message
     * about the same environment with a stack trace out of a logger constructor.
     */
    it("falls back to full redaction when the environment does not parse", () => {
      expect(readLoggingEnv({ LOG_REDACTION_ENABLED: "nonsense" }).LOG_REDACTION_ENABLED).toBe(
        true,
      );
    });

    it("falls back to full redaction for an environment production would refuse", () => {
      expect(
        readLoggingEnv({ NODE_ENV: "production", LOG_REDACTION_ENABLED: "false" })
          .LOG_REDACTION_ENABLED,
      ).toBe(true);
    });
  });
});
