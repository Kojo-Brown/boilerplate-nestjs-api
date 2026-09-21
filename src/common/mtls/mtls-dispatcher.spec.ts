import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import type { HttpDispatcher } from "@/common/http";
import { createTestCertificateAuthority } from "@/test-utils/test-certificates";
import type { TestCertificateAuthority } from "@/test-utils/test-certificates";
import { MtlsKeyMaterialService } from "./key-material.service";
import { MtlsDispatcherRegistry, createPeerAgent, verifyPeerCertificate } from "./mtls-dispatcher";

const ORDERS = "spiffe://cluster.local/ns/prod/sa/orders";
const WEB = "spiffe://cluster.local/ns/prod/sa/web";
const NOW = new Date(Date.now() + 60_000);

/** A peer certificate as `checkServerIdentity` receives one. */
function certificate(subjectAltName: string, commonName = "orders"): PeerCertificate {
  return {
    subjectaltname: subjectAltName,
    subject: { CN: commonName },
  } as unknown as PeerCertificate;
}

function silentLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe("verifyPeerCertificate", () => {
  it("accepts a server whose URI SAN is the identity MTLS_PEERS names", () => {
    expect(
      verifyPeerCertificate(ORDERS, "orders.internal", certificate(`URI:${ORDERS}`)),
    ).toBeUndefined();
  });

  /**
   * The check that makes a private CA usable as an authority instead of as a
   * blanket permission: this certificate is signed by the same CA, is in date,
   * and belongs to a different workload.
   */
  it("refuses a valid certificate belonging to another workload", () => {
    const failure = verifyPeerCertificate(ORDERS, "orders.internal", certificate(`URI:${WEB}`));

    expect(failure?.message).toContain(WEB);
    expect(failure?.message).toContain(ORDERS);
  });

  /**
   * A SPIFFE leaf carries a URI SAN and no DNS SAN, so `tls.checkServerIdentity`
   * fails every one of them. Skipping it is not a weakening: the URI has to
   * match exactly, which is a stronger statement than the hostname.
   */
  it("does not require the hostname to match for a SPIFFE identity", () => {
    expect(
      verifyPeerCertificate(ORDERS, "10.42.0.9", certificate(`URI:${ORDERS}`)),
    ).toBeUndefined();
  });

  it("requires both the SAN and the hostname to match for a DNS identity", () => {
    expect(
      verifyPeerCertificate(
        "orders.internal",
        "orders.internal",
        certificate("DNS:orders.internal"),
      ),
    ).toBeUndefined();

    // The certificate names the peer we expected; the address we dialled is not
    // a name on it, which is the ordinary TLS failure and stays one — Node's
    // own, passed through rather than reworded. Asserted on its message and
    // code rather than with `instanceof`, because an error thrown from inside
    // Node's internals is not an instance of this test realm's `Error`.
    const mismatch = verifyPeerCertificate(
      "orders.internal",
      "shipping.internal",
      certificate("DNS:orders.internal"),
    );
    expect(mismatch?.message).toContain("shipping.internal");
    expect(mismatch).toHaveProperty("code", "ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("refuses a server that presented no identity at all", () => {
    expect(verifyPeerCertificate(ORDERS, "orders.internal", certificate(""))?.message).toContain(
      "no URI or DNS SAN",
    );
  });
});

describe("MtlsDispatcherRegistry", () => {
  const directory = mkdtempSync(join(tmpdir(), "mtls-dispatch-"));
  const files = {
    certFile: join(directory, "tls.crt"),
    keyFile: join(directory, "tls.key"),
    caFile: join(directory, "ca.crt"),
  };
  let ca: TestCertificateAuthority;
  let material: MtlsKeyMaterialService;

  function writeMaterial(identity: string): void {
    const issued = ca.issue({ commonName: "web", subjectAltNames: [`URI:${identity}`] });
    writeFileSync(files.certFile, issued.certPem);
    writeFileSync(files.keyFile, issued.keyPem);
    writeFileSync(files.caFile, ca.certPem);
  }

  beforeEach(() => {
    ca = createTestCertificateAuthority();
    writeMaterial(WEB);
    material = new MtlsKeyMaterialService({
      files,
      reloadIntervalMs: 0,
      expiryWarningDays: 0,
      now: () => NOW,
      logger: silentLogger(),
    });
    material.start();
  });

  afterEach(() => material.stop());

  it("hands out a dispatcher for a configured peer and nothing for anyone else", async () => {
    const registry = new MtlsDispatcherRegistry(
      new Map([["https://orders.internal:8443", ORDERS]]),
      material,
      silentLogger(),
    );
    registry.start();

    expect(registry.dispatcherFor("https://orders.internal:8443/v1/orders?page=2")).toBeDefined();
    // A third party: our private anchors say nothing about it, and pinning them
    // on this call would break the integration rather than secure it.
    expect(registry.dispatcherFor("https://api.stripe.com/v1/charges")).toBeUndefined();
    // Same host, different port — a different workload as often as not.
    expect(registry.dispatcherFor("https://orders.internal:9443/v1/orders")).toBeUndefined();
    expect(registry.dispatcherFor("not a url")).toBeUndefined();

    await registry.close();
  });

  it("rebuilds its dispatchers from the rotated material", async () => {
    const registry = new MtlsDispatcherRegistry(
      new Map([["https://orders.internal", ORDERS]]),
      material,
      silentLogger(),
    );
    registry.start();
    const before = registry.dispatcherFor("https://orders.internal/v1/orders");

    writeMaterial("spiffe://cluster.local/ns/prod/sa/web-v2");
    expect(material.reload()).toBe("rotated");

    const after = registry.dispatcherFor("https://orders.internal/v1/orders");
    expect(after).toBeDefined();
    // A new dispatcher, because the client certificate lives on it: the old one
    // would go on presenting the material it was built from until the process
    // restarted.
    expect(after).not.toBe(before);

    await registry.close();
  });

  it("closes every dispatcher and unsubscribes from rotations", async () => {
    const registry = new MtlsDispatcherRegistry(
      new Map([["https://orders.internal", ORDERS]]),
      material,
      silentLogger(),
    );
    registry.start();

    await registry.close();

    expect(registry.dispatcherFor("https://orders.internal/v1/orders")).toBeUndefined();
    writeMaterial("spiffe://cluster.local/ns/prod/sa/web-v3");
    expect(material.reload()).toBe("rotated");
    expect(registry.dispatcherFor("https://orders.internal/v1/orders")).toBeUndefined();
  });
});

describe("createPeerAgent", () => {
  it("builds a dispatcher `fetch` accepts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mtls-agent-"));
    const ca = createTestCertificateAuthority();
    const issued = ca.issue({ commonName: "web", subjectAltNames: [`URI:${WEB}`] });
    const certFile = join(directory, "tls.crt");
    const keyFile = join(directory, "tls.key");
    const caFile = join(directory, "ca.crt");
    writeFileSync(certFile, issued.certPem);
    writeFileSync(keyFile, issued.keyPem);
    writeFileSync(caFile, ca.certPem);
    const service = new MtlsKeyMaterialService({
      files: { certFile, keyFile, caFile },
      reloadIntervalMs: 0,
      expiryWarningDays: 0,
      now: () => NOW,
      logger: silentLogger(),
    });

    const agent = createPeerAgent(service.start(), ORDERS);

    // The type is the point: `HttpDispatcher` is what `ResilientHttpClient`
    // hands to the transport, so an agent that did not satisfy it would be a
    // compile error here rather than a silent fall-back to the global
    // dispatcher at runtime. That it *works* is `test/mtls.e2e-spec.ts`.
    const dispatcher: HttpDispatcher = agent;
    expect(dispatcher).toBe(agent);

    await agent.close();
    service.stop();
  });
});
