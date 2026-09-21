import { TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { allowsAnyPeer, matchPeerIdentity, peerIdentitiesFrom } from "./peer-identity";

/**
 * Deciding whether the peer on the other end of a connection may make this
 * request.
 *
 * Authentication happened during the handshake: OpenSSL verified that the
 * client's certificate chains to a trust anchor we mounted. This is the other
 * half — authorisation — and the two are genuinely different questions. A trust
 * anchor answers "is this a workload in our trust domain"; it has nothing to
 * say about whether *that* workload is one this service takes calls from, and
 * in a mesh the CA has issued a certificate to everything, including the batch
 * job that should never reach this API at all.
 */

/** What the decision needs to know about a connection. A plain object, so a test needs no socket. */
export interface PeerConnection {
  /** Whether the connection is TLS at all. */
  readonly encrypted: boolean;
  /** OpenSSL's verdict on the peer's certificate chain. */
  readonly authorized: boolean;
  /** Why it said no, when it did. */
  readonly authorizationError?: string | null;
  /** The peer certificate's SAN extension, verbatim. */
  readonly subjectAltName?: string | null;
  /** The peer certificate's subject, for the log line only — never for matching. */
  readonly subject?: string | null;
}

export interface PeerPolicy {
  /** Identities that may call, or `["*"]`. */
  readonly allowlist: readonly string[];
  /** Paths reachable without a client certificate. */
  readonly exemptPrefixes: readonly string[];
}

export type PeerDecision =
  | {
      readonly allowed: true;
      /** The matched identity, or `null` for an exempt path or a wildcard allowlist. */
      readonly identity: string | null;
      /** Whether the path was exempt rather than the peer authorised. */
      readonly exempt: boolean;
    }
  | {
      readonly allowed: false;
      /** A short machine-ish reason, for metrics and tests. */
      readonly reason: "not-tls" | "no-certificate" | "unknown-identity";
      /** A sentence naming what was presented and what was expected. */
      readonly detail: string;
    };

/**
 * Whether `path` is one of the prefixes that may be reached without a
 * certificate.
 *
 * Prefix matching, and the prefix has to be followed by the end of the path or
 * a `/`: `"/v1/health"` must not exempt `"/v1/healthcheck-internal"`, which is
 * exactly the kind of route somebody adds later.
 */
export function isExemptPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    if (!path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length);
    return rest.length === 0 || rest.startsWith("/");
  });
}

/** The authorisation decision for one request. */
export function authorizePeer(
  connection: PeerConnection,
  path: string,
  policy: PeerPolicy,
): PeerDecision {
  const identities = peerIdentitiesFrom(connection.subjectAltName);
  const exempt = isExemptPath(path, policy.exemptPrefixes);

  // Checked before the TLS state, not after: an exempt path exists precisely
  // for the callers that cannot present a certificate, and a kubelet probe has
  // neither an identity nor a way to get one.
  if (exempt) {
    return { allowed: true, identity: identities[0] ?? null, exempt: true };
  }

  if (!connection.encrypted) {
    return {
      allowed: false,
      reason: "not-tls",
      detail:
        "The request arrived over a connection that is not TLS, so there is no peer " +
        "certificate to authorise. With MTLS_ENABLED on, every listener this process serves " +
        "should be the TLS one — a plaintext port in front of it makes the whole mechanism " +
        "advisory.",
    };
  }

  if (!connection.authorized) {
    return {
      allowed: false,
      reason: "no-certificate",
      detail:
        `The peer presented no certificate the trust anchors accept` +
        `${connection.authorizationError ? ` (${connection.authorizationError})` : ""}. ` +
        `This is only reachable with MTLS_ALLOW_UNAUTHENTICATED_PROBES on — otherwise the ` +
        `handshake itself would have failed.`,
    };
  }

  if (allowsAnyPeer(policy.allowlist)) {
    return { allowed: true, identity: identities[0] ?? null, exempt: false };
  }

  const matched = matchPeerIdentity(identities, policy.allowlist);
  if (matched !== null) return { allowed: true, identity: matched, exempt: false };

  return {
    allowed: false,
    reason: "unknown-identity",
    detail:
      `The peer's certificate is valid but its identity is not one this service takes calls ` +
      `from. Presented: ${identities.length === 0 ? "no URI or DNS SAN" : identities.join(", ")}` +
      `${connection.subject ? ` (subject ${connection.subject})` : ""}. Allowed: ` +
      `${policy.allowlist.join(", ")}.`,
  };
}

/**
 * Reads what {@link authorizePeer} needs off a socket.
 *
 * `instanceof TLSSocket` rather than a duck-type check on `encrypted`: a
 * plaintext `net.Socket` has no such property, so the two are distinguishable,
 * and getting this wrong in the permissive direction would authorise every
 * request on a plaintext listener.
 */
export function describeConnection(socket: Socket): PeerConnection {
  if (!(socket instanceof TLSSocket)) return { encrypted: false, authorized: false };

  // `getPeerCertificate()` returns `{}` — not null — when there is no peer
  // certificate, which is why the SAN is read defensively rather than asserted.
  const certificate = socket.getPeerCertificate();
  return {
    encrypted: true,
    authorized: socket.authorized,
    authorizationError: socket.authorizationError?.message ?? null,
    subjectAltName: certificate.subjectaltname ?? null,
    subject: commonNameOf(certificate.subject?.CN),
  };
}

/**
 * The subject CN, for the log line only.
 *
 * Typed as `string | string[]` because a subject really can carry several CNs,
 * which is one more reason not to identify a peer by one.
 */
function commonNameOf(commonName: string | string[] | undefined): string | null {
  if (commonName === undefined) return null;
  return Array.isArray(commonName) ? commonName.join(", ") : commonName;
}
