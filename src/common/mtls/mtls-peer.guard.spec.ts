import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type { PeerCertificate } from "node:tls";
import { stubConfig } from "@/test-utils/stub-config";
import { MtlsPeerGuard } from "./mtls-peer.guard";

const ORDERS = "spiffe://cluster.local/ns/prod/sa/orders";

/**
 * A request as the guard reads one: a path and a socket.
 *
 * The socket is a real one — plaintext or TLS — because the branch the guard
 * takes depends on `instanceof TLSSocket`, and a plain object claiming to be
 * encrypted would take a branch no deployment can.
 */
function context(path: string, socket: Socket, type: "http" | "ws" = "http"): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => ({ path, method: "GET", socket }),
    }),
  } as unknown as ExecutionContext;
}

/** A TLS socket that reports the verdict and certificate a handshake would have left. */
function tlsSocket(state: { authorized: boolean; subjectAltName?: string }): TLSSocket {
  const socket = new TLSSocket(new Socket());
  Object.defineProperty(socket, "authorized", { value: state.authorized });
  const certificate = {
    subjectaltname: state.subjectAltName,
    subject: { CN: "orders" },
  } as unknown as PeerCertificate;
  // Defined rather than assigned: `getPeerCertificate` is an overload set, and
  // a single-signature function is not assignable to one.
  Object.defineProperty(socket, "getPeerCertificate", { value: () => certificate });
  return socket;
}

function guardFor(env: Record<string, unknown>): MtlsPeerGuard {
  return new MtlsPeerGuard(stubConfig(env));
}

describe("MtlsPeerGuard", () => {
  const sockets: Socket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
  });

  function socket(state: { authorized: boolean; subjectAltName?: string }): TLSSocket {
    const created = tlsSocket(state);
    sockets.push(created);
    return created;
  }

  it("is a pass-through when mTLS is off, which is how it can be bound unconditionally", () => {
    const guard = guardFor({ MTLS_ENABLED: false });

    expect(guard.canActivate(context("/v1/orders", new Socket()))).toBe(true);
  });

  it("admits a peer on the allowlist", () => {
    const guard = guardFor({
      MTLS_ENABLED: true,
      MTLS_CERT_FILE: "/tls/tls.crt",
      MTLS_KEY_FILE: "/tls/tls.key",
      MTLS_CA_FILE: "/tls/ca.crt",
      MTLS_ALLOWED_CLIENTS: ORDERS,
    });

    expect(
      guard.canActivate(
        context("/v1/orders", socket({ authorized: true, subjectAltName: `URI:${ORDERS}` })),
      ),
    ).toBe(true);
  });

  it("refuses a valid certificate from a workload this service does not talk to", () => {
    const guard = guardFor({ MTLS_ENABLED: true, MTLS_ALLOWED_CLIENTS: ORDERS });
    const peer = socket({
      authorized: true,
      subjectAltName: "URI:spiffe://cluster.local/ns/dev/sa/scratch",
    });

    expect(() => guard.canActivate(context("/v1/orders", peer))).toThrow(ForbiddenException);
  });

  /**
   * `ForbiddenException` rather than ending the response here: it goes through
   * `AllExceptionsFilter`, so the caller gets this API's error envelope and its
   * correlation id like every other refusal.
   */
  it("refuses with a reason the caller can act on and no allowlist in the body", () => {
    const guard = guardFor({ MTLS_ENABLED: true, MTLS_ALLOWED_CLIENTS: ORDERS });
    const peer = socket({ authorized: true, subjectAltName: "URI:spiffe://c/ns/dev/sa/scratch" });

    try {
      guard.canActivate(context("/v1/orders", peer));
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      const message = (error as ForbiddenException).message;
      expect(message).toContain("unknown-identity");
      expect(message).not.toContain(ORDERS);
    }
  });

  it("lets an exempt path through for a caller with no certificate", () => {
    const guard = guardFor({
      MTLS_ENABLED: true,
      MTLS_ALLOWED_CLIENTS: ORDERS,
      MTLS_EXEMPT_PREFIXES: "/v1/health",
      MTLS_ALLOW_UNAUTHENTICATED_PROBES: true,
    });

    expect(guard.canActivate(context("/v1/health", socket({ authorized: false })))).toBe(true);
  });

  it("refuses everything outside the exempt prefixes when probes are allowed in", () => {
    const guard = guardFor({
      MTLS_ENABLED: true,
      MTLS_ALLOWED_CLIENTS: ORDERS,
      MTLS_EXEMPT_PREFIXES: "/v1/health",
      MTLS_ALLOW_UNAUTHENTICATED_PROBES: true,
    });

    expect(() => guard.canActivate(context("/v1/orders", socket({ authorized: false })))).toThrow(
      ForbiddenException,
    );
  });

  it("leaves a non-HTTP context alone: its connection was authenticated in the same handshake", () => {
    const guard = guardFor({ MTLS_ENABLED: true, MTLS_ALLOWED_CLIENTS: ORDERS });

    expect(guard.canActivate(context("/v1/realtime", new Socket(), "ws"))).toBe(true);
  });
});
