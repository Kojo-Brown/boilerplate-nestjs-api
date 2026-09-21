import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createTestCertificateAuthority } from "@/test-utils/test-certificates";
import type { TestCertificateAuthority } from "@/test-utils/test-certificates";
import { MtlsRuntime, mtls, readMtlsEnv } from "./mtls-runtime";
import { mtlsEnvShape } from "./mtls.env";

const envSchema = z.object(mtlsEnvShape);
const ORDERS = "spiffe://cluster.local/ns/prod/sa/orders";
const WEB = "spiffe://cluster.local/ns/prod/sa/web";

describe("MtlsRuntime", () => {
  const directory = mkdtempSync(join(tmpdir(), "mtls-runtime-"));
  const certFile = join(directory, "tls.crt");
  const keyFile = join(directory, "tls.key");
  const caFile = join(directory, "ca.crt");
  let ca: TestCertificateAuthority;
  let runtime: MtlsRuntime;

  function writeMaterial(identity: string): void {
    const issued = ca.issue({ commonName: "web", subjectAltNames: [`URI:${identity}`] });
    writeFileSync(certFile, issued.certPem);
    writeFileSync(keyFile, issued.keyPem);
    writeFileSync(caFile, ca.certPem);
  }

  function env(overrides: Record<string, unknown> = {}) {
    return envSchema.parse({
      MTLS_ENABLED: true,
      MTLS_CERT_FILE: certFile,
      MTLS_KEY_FILE: keyFile,
      MTLS_CA_FILE: caFile,
      MTLS_RELOAD_INTERVAL_MS: 0,
      MTLS_EXPIRY_WARNING_DAYS: 0,
      ...overrides,
    });
  }

  beforeEach(() => {
    ca = createTestCertificateAuthority();
    writeMaterial(WEB);
    runtime = new MtlsRuntime();
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it("does nothing at all when mTLS is off", async () => {
    expect(runtime.start(envSchema.parse({}))).toBeUndefined();
    expect(runtime.enabled).toBe(false);
    expect(runtime.material()).toBeNull();
    // Which is what makes the client's `dispatcherFor` safe to wire in
    // unconditionally: every URL comes back undefined, so every call goes out
    // through the global dispatcher exactly as it did before.
    expect(runtime.dispatcherFor("https://orders.internal/v1/orders")).toBeUndefined();
  });

  it("loads the material and returns the listener's TLS options", () => {
    const options = runtime.start(env());

    expect(options?.requestCert).toBe(true);
    expect(options?.rejectUnauthorized).toBe(true);
    expect(runtime.material()?.current().identities).toEqual([WEB]);
  });

  it("builds a dispatcher for each configured peer and none for anyone else", () => {
    runtime.start(env({ MTLS_PEERS: `https://orders.internal=${ORDERS}` }));

    expect(runtime.dispatcherFor("https://orders.internal/v1/orders")).toBeDefined();
    expect(runtime.dispatcherFor("https://api.stripe.com/v1/charges")).toBeUndefined();
  });

  it("refuses to start on material that does not load", () => {
    writeFileSync(certFile, "");

    expect(() => runtime.start(env())).toThrow(/contains no PEM certificate block/);
  });

  it("refuses to start with a file missing from an environment that never went through envSchema", () => {
    // Reachable only by constructing the environment by hand, which is exactly
    // when a clear message is worth having.
    expect(() => runtime.start({ ...env(), MTLS_CERT_FILE: undefined })).toThrow(
      /MTLS_CERT_FILE is required/,
    );
  });

  it("keeps a listening server's context in step with the material", () => {
    runtime.start(env());
    const setSecureContext = jest.fn();
    runtime.attachTo({ setSecureContext });

    writeMaterial("spiffe://cluster.local/ns/prod/sa/web-v2");
    runtime.material()?.reload();

    expect(setSecureContext).toHaveBeenCalledTimes(1);
  });

  it("attaches to one server at a time, so a second call does not double-notify", () => {
    runtime.start(env());
    const first = jest.fn();
    const second = jest.fn();
    runtime.attachTo({ setSecureContext: first });
    runtime.attachTo({ setSecureContext: second });

    writeMaterial("spiffe://cluster.local/ns/prod/sa/web-v2");
    runtime.material()?.reload();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ignores a server when mTLS is off rather than holding a rotation nobody feeds", () => {
    runtime.start(envSchema.parse({}));
    const setSecureContext = jest.fn();

    expect(() => runtime.attachTo({ setSecureContext })).not.toThrow();
    expect(setSecureContext).not.toHaveBeenCalled();
  });

  it("stops the reload timer and closes the dispatchers", async () => {
    runtime.start(env({ MTLS_PEERS: `https://orders.internal=${ORDERS}` }));

    await runtime.stop();

    expect(runtime.enabled).toBe(false);
    expect(runtime.material()).toBeNull();
    expect(runtime.dispatcherFor("https://orders.internal/v1/orders")).toBeUndefined();
    // Idempotent: `main.ts` calls it on a shutdown path that also races a
    // force-exit timer.
    await runtime.stop();
  });
});

describe("the process-wide handle", () => {
  it("is off until something starts it, so importing it changes nothing", () => {
    expect(mtls.enabled).toBe(false);
    expect(mtls.dispatcherFor("https://orders.internal/v1/orders")).toBeUndefined();
  });
});

describe("readMtlsEnv", () => {
  it("reads process.env by default", () => {
    expect(readMtlsEnv().MTLS_ENABLED).toBe(false);
  });

  it("refuses an environment envSchema would refuse", () => {
    expect(() => readMtlsEnv({ MTLS_ENABLED: "true" })).toThrow(/MTLS_CERT_FILE is required/);
  });
});
