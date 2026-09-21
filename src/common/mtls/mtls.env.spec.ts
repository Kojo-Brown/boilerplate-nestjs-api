import { z } from "zod";
import { stubConfig } from "@/test-utils/stub-config";
import {
  collectMtlsIssues,
  mtlsEnvFrom,
  mtlsEnvFromProcess,
  mtlsEnvShape,
  parseAllowedClients,
  parseExemptPrefixes,
  parsePeerMap,
  refineMtlsEnv,
} from "./mtls.env";

/**
 * The mTLS shape on its own, refined exactly as `envSchema` refines it — the
 * same arrangement `security.env.spec.ts` uses, so a failing expectation names
 * the rule under test rather than every unrelated variable a full environment
 * would also have to satisfy.
 */
const schema = z.object(mtlsEnvShape).superRefine((env, ctx) => refineMtlsEnv(env, nodeEnv, ctx));

let nodeEnv: string | undefined = "test";

beforeEach(() => {
  nodeEnv = "test";
});

const FILES = {
  MTLS_CERT_FILE: "/tls/tls.crt",
  MTLS_KEY_FILE: "/tls/tls.key",
  MTLS_CA_FILE: "/tls/ca.crt",
};

const ORDERS = "spiffe://cluster.local/ns/prod/sa/orders";

function messagesFor(env: Record<string, unknown>): string[] {
  const result = schema.safeParse(env);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("defaults", () => {
  it("leaves a clean clone on plain HTTP with nothing configured", () => {
    const env = schema.parse({});

    expect(env.MTLS_ENABLED).toBe(false);
    expect(env.MTLS_PEERS).toBe("");
    expect(parseExemptPrefixes(env)).toEqual(["/v1/health", "/metrics"]);
    expect(parseAllowedClients(env)).toEqual(["*"]);
  });

  it("reads the strings an operator types, not only booleans", () => {
    expect(schema.parse({ ...FILES, MTLS_ENABLED: "true" }).MTLS_ENABLED).toBe(true);
    // The reason this is a union rather than `z.coerce.boolean()`: coercion
    // makes every non-empty string true, so "false" would enable it.
    expect(schema.parse({ MTLS_ENABLED: "false" }).MTLS_ENABLED).toBe(false);
  });
});

describe("refineMtlsEnv", () => {
  it("requires the three files once mTLS is on", () => {
    expect(messagesFor({ MTLS_ENABLED: true })).toEqual([
      "MTLS_CERT_FILE is required when MTLS_ENABLED is on.",
      "MTLS_KEY_FILE is required when MTLS_ENABLED is on.",
      "MTLS_CA_FILE is required when MTLS_ENABLED is on.",
    ]);
  });

  it("accepts a complete configuration", () => {
    expect(
      messagesFor({
        ...FILES,
        MTLS_ENABLED: true,
        MTLS_ALLOWED_CLIENTS: `${ORDERS},gateway.internal`,
        MTLS_PEERS: `https://orders.internal:8443=${ORDERS}`,
      }),
    ).toEqual([]);
  });

  /**
   * A peer list without material to present is the configuration that looks
   * like working mTLS and is not: the calls go out, they succeed, and they are
   * authenticated in one direction only — until the peer starts requiring a
   * certificate, which is the day this was supposed to have been ready.
   */
  it("refuses outbound peers while mTLS is off", () => {
    expect(messagesFor({ MTLS_PEERS: `https://orders.internal=${ORDERS}` })[0]).toContain(
      "MTLS_PEERS is set while MTLS_ENABLED is off",
    );
  });

  it("refuses an empty allowlist, which would deny every peer", () => {
    expect(messagesFor({ ...FILES, MTLS_ENABLED: true, MTLS_ALLOWED_CLIENTS: " , " })[0]).toContain(
      "denies every peer",
    );
  });

  it("refuses an allowlist entry no certificate could match", () => {
    expect(
      messagesFor({ ...FILES, MTLS_ENABLED: true, MTLS_ALLOWED_CLIENTS: "*.internal" })[0],
    ).toContain("is not a peer identity");
  });

  it("refuses the wildcard allowlist in production and allows it elsewhere", () => {
    nodeEnv = "production";
    expect(messagesFor({ ...FILES, MTLS_ENABLED: true })[0]).toContain("refused in production");

    nodeEnv = "development";
    expect(messagesFor({ ...FILES, MTLS_ENABLED: true })).toEqual([]);
  });

  it("refuses an exempt prefix that is not a path", () => {
    expect(
      messagesFor({ ...FILES, MTLS_ENABLED: true, MTLS_EXEMPT_PREFIXES: "v1/health" })[0],
    ).toContain('does not start with "/"');
  });

  it("refuses unauthenticated probes with nothing to exempt", () => {
    expect(
      messagesFor({
        ...FILES,
        MTLS_ENABLED: true,
        MTLS_ALLOW_UNAUTHENTICATED_PROBES: true,
        MTLS_EXEMPT_PREFIXES: "",
      })[0],
    ).toContain("the weakening with none of the benefit");
  });

  it("refuses a reload interval that would re-read the files more than once a second", () => {
    expect(
      messagesFor({ ...FILES, MTLS_ENABLED: true, MTLS_RELOAD_INTERVAL_MS: 250 })[0],
    ).toContain("more than once a second");
    expect(messagesFor({ ...FILES, MTLS_ENABLED: true, MTLS_RELOAD_INTERVAL_MS: 0 })).toEqual([]);
  });

  it.each([
    ["https://orders.internal", 'has no "="'],
    [`https://orders.internal/v1=${ORDERS}`, "is not an origin"],
    [`http://orders.internal=${ORDERS}`, "is not https"],
    ["https://orders.internal=*.internal", "is not a peer identity"],
  ])("refuses the peer entry %s", (peers, expected) => {
    const messages = messagesFor({ ...FILES, MTLS_ENABLED: true, MTLS_PEERS: peers });
    expect(messages.some((message) => message.includes(expected))).toBe(true);
  });
});

describe("parsePeerMap", () => {
  it("maps each origin to the identity it must present", () => {
    const peers = parsePeerMap(
      `https://orders.internal:8443=${ORDERS}, https://billing.internal=billing.internal`,
    );

    expect([...peers]).toEqual([
      ["https://orders.internal:8443", ORDERS],
      ["https://billing.internal", "billing.internal"],
    ]);
  });

  it("is empty for the default, which is every call going out as it did before", () => {
    expect(parsePeerMap("").size).toBe(0);
  });
});

describe("mtlsEnvFrom", () => {
  it("reads the settings back out of a validated configuration", () => {
    const env = mtlsEnvFrom(
      stubConfig({ ...FILES, MTLS_ENABLED: true, MTLS_ALLOWED_CLIENTS: ORDERS }),
    );

    expect(env.MTLS_ENABLED).toBe(true);
    expect(parseAllowedClients(env)).toEqual([ORDERS]);
  });
});

describe("mtlsEnvFromProcess", () => {
  it("parses the same shape main.ts needs before ConfigService exists", () => {
    const env = mtlsEnvFromProcess({ ...FILES, MTLS_ENABLED: "true", NODE_ENV: "test" });

    expect(env.MTLS_CERT_FILE).toBe("/tls/tls.crt");
  });

  /**
   * The pre-Nest read must refuse what `envSchema` would refuse. A laxer parse
   * here would mean a process that loads its material, binds a listener and
   * *then* fails validation — with a socket already accepting connections.
   */
  it("applies the same cross-field rules, so the two parses cannot disagree", () => {
    expect(() => mtlsEnvFromProcess({ MTLS_ENABLED: "true" })).toThrow(
      /MTLS_CERT_FILE is required/,
    );
    expect(() =>
      mtlsEnvFromProcess({ ...FILES, MTLS_ENABLED: "true", NODE_ENV: "production" }),
    ).toThrow(/refused in production/);
  });

  it("returns the defaults when nothing is set, which is how mTLS stays opt-in", () => {
    expect(mtlsEnvFromProcess({}).MTLS_ENABLED).toBe(false);
  });
});

describe("collectMtlsIssues", () => {
  it("reports every problem at once rather than the first", () => {
    const parsed = z.object(mtlsEnvShape).parse({
      MTLS_ENABLED: true,
      MTLS_ALLOWED_CLIENTS: "*.internal",
      MTLS_RELOAD_INTERVAL_MS: 10,
    });

    // Three files, one allowlist entry, one interval: an operator fixing these
    // one boot at a time is five deployments.
    expect(collectMtlsIssues(parsed, "test")).toHaveLength(5);
  });
});
