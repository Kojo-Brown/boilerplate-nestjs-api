import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { authorizePeer, describeConnection, isExemptPath } from "./peer-authorization";
import type { PeerConnection, PeerPolicy } from "./peer-authorization";

const ORDERS = "spiffe://cluster.local/ns/prod/sa/orders";
const WEB = "spiffe://cluster.local/ns/prod/sa/web";

const policy: PeerPolicy = {
  allowlist: [ORDERS, "gateway.internal"],
  exemptPrefixes: ["/v1/health", "/metrics"],
};

function peer(overrides: Partial<PeerConnection> = {}): PeerConnection {
  return { encrypted: true, authorized: true, subjectAltName: `URI:${ORDERS}`, ...overrides };
}

describe("isExemptPath", () => {
  it("matches the prefix itself and anything below it", () => {
    expect(isExemptPath("/v1/health", policy.exemptPrefixes)).toBe(true);
    expect(isExemptPath("/v1/health/ready", policy.exemptPrefixes)).toBe(true);
  });

  /**
   * The mistake a plain `startsWith` makes, and the reason this is not one: a
   * route added later whose path merely begins with an exempt prefix would
   * inherit the exemption silently.
   */
  it("does not exempt a longer path segment that merely starts the same way", () => {
    expect(isExemptPath("/v1/healthcheck-internal", policy.exemptPrefixes)).toBe(false);
  });

  it("exempts nothing when the list is empty", () => {
    expect(isExemptPath("/v1/health", [])).toBe(false);
  });
});

describe("authorizePeer", () => {
  it("admits a peer whose identity is on the list", () => {
    expect(authorizePeer(peer(), "/v1/orders", policy)).toEqual({
      allowed: true,
      identity: ORDERS,
      exempt: false,
    });
  });

  /**
   * The distinction the whole module is about: this peer's certificate is
   * valid, current, and signed by the same CA as everybody else's. It is a real
   * workload in the trust domain, and it is not one this service takes calls
   * from.
   */
  it("refuses a peer the CA vouches for but the allowlist does not name", () => {
    const decision = authorizePeer(peer({ subjectAltName: `URI:${WEB}` }), "/v1/orders", policy);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("unknown-identity");
    expect(decision.detail).toContain(WEB);
  });

  it("admits anyone the CA vouches for when the allowlist is the wildcard", () => {
    const wildcard: PeerPolicy = { allowlist: ["*"], exemptPrefixes: [] };

    expect(authorizePeer(peer({ subjectAltName: `URI:${WEB}` }), "/v1/orders", wildcard)).toEqual({
      allowed: true,
      identity: WEB,
      exempt: false,
    });
  });

  it("refuses a connection that carried no accepted certificate", () => {
    const decision = authorizePeer(
      peer({ authorized: false, authorizationError: "UNABLE_TO_GET_ISSUER_CERT" }),
      "/v1/orders",
      policy,
    );

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("no-certificate");
    expect(decision.detail).toContain("UNABLE_TO_GET_ISSUER_CERT");
  });

  it("refuses a request that did not arrive over TLS at all", () => {
    const decision = authorizePeer({ encrypted: false, authorized: false }, "/v1/orders", policy);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("not-tls");
  });

  it("lets an exempt path through without a certificate, which is what it is for", () => {
    expect(
      authorizePeer({ encrypted: true, authorized: false }, "/v1/health/ready", policy),
    ).toEqual({ allowed: true, identity: null, exempt: true });
  });

  it("matches a DNS identity from the allowlist as readily as a SPIFFE one", () => {
    expect(
      authorizePeer(peer({ subjectAltName: "DNS:gateway.internal" }), "/v1/orders", policy),
    ).toEqual({ allowed: true, identity: "gateway.internal", exempt: false });
  });

  it("refuses an authorised peer whose certificate carries no identity", () => {
    const decision = authorizePeer(peer({ subjectAltName: null }), "/v1/orders", policy);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.detail).toContain("no URI or DNS SAN");
  });
});

describe("describeConnection", () => {
  it("reports a plaintext socket as what it is, rather than as an unauthorised peer", () => {
    const socket = new Socket();

    expect(describeConnection(socket)).toEqual({ encrypted: false, authorized: false });
  });

  it("reads the TLS state off a TLS socket", () => {
    // A `TLSSocket` that has not handshaken: `authorized` is false and
    // `getPeerCertificate()` is `{}` rather than null, which is the shape the
    // reader has to survive.
    const socket = new TLSSocket(new Socket());

    expect(describeConnection(socket)).toEqual({
      encrypted: true,
      authorized: false,
      authorizationError: null,
      subjectAltName: null,
      subject: null,
    });

    socket.destroy();
  });
});
