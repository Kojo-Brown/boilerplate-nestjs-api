import { Logger } from "@nestjs/common";
import { checkServerIdentity as checkHostname } from "node:tls";
import type { PeerCertificate } from "node:tls";
import { Agent } from "undici";
import type { KeyMaterial } from "./key-material";
import type { MtlsKeyMaterialService, MtlsLogger } from "./key-material.service";
import { matchPeerIdentity, peerIdentitiesFrom } from "./peer-identity";

/**
 * The outbound half: presenting this service's certificate to an internal peer,
 * and checking the certificate that peer presents back.
 *
 * `fetch` has no per-request TLS options — it is undici underneath, and the
 * client material lives on the dispatcher rather than on the call — so talking
 * to one peer with a certificate and to Stripe without one means two
 * dispatchers. That is what this file builds: one {@link Agent} per configured
 * peer origin, handed to `fetch` through `init.dispatcher` by
 * `ResilientHttpClient`, and rebuilt when the material rotates.
 *
 * Calls to anything not in `MTLS_PEERS` get no dispatcher at all and go out
 * through the global one, against the public trust store. That is deliberate:
 * a private CA has nothing to say about `api.stripe.com`, and pointing `ca` at
 * it for every outbound call would break every third-party integration at once.
 */
export class MtlsDispatcherRegistry {
  private readonly logger: MtlsLogger;
  private agents = new Map<string, Agent>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly peers: ReadonlyMap<string, string>,
    private readonly material: MtlsKeyMaterialService,
    logger?: MtlsLogger,
  ) {
    this.logger = logger ?? new Logger(MtlsDispatcherRegistry.name);
  }

  /** Builds a dispatcher per peer and keeps them in step with the material. */
  start(): void {
    this.agents = this.build(this.material.current());
    this.unsubscribe = this.material.onRotate((rotated) => this.rebuild(rotated));
  }

  /**
   * The dispatcher for `url`, or `undefined` when the call is not to a
   * configured peer.
   *
   * Matched on the origin rather than the host: a peer reached on two ports is
   * two workloads as often as it is one.
   */
  dispatcherFor(url: string): Agent | undefined {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      // Not a URL `fetch` could send anyway — let the transport produce the
      // error rather than inventing one here.
      return undefined;
    }
    return this.agents.get(origin);
  }

  /** Closes every dispatcher, waiting for in-flight requests to finish. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const closing = [...this.agents.values()].map((agent) => agent.close());
    this.agents = new Map();
    await Promise.allSettled(closing);
  }

  /**
   * Swaps in dispatchers built from the new material and closes the old ones.
   *
   * `close()` rather than `destroy()`, and not awaited: closing is graceful —
   * it stops new requests and resolves once the ones already on the wire have
   * finished. Destroying would abort them, which turns every rotation into a
   * handful of failed calls for no benefit, since a request already in flight
   * was authenticated with material that was valid when it was sent.
   */
  private rebuild(rotated: KeyMaterial): void {
    const previous = this.agents;
    this.agents = this.build(rotated);
    for (const agent of previous.values()) {
      void agent.close().catch((cause: unknown) => {
        this.logger.warn(
          `Closing a rotated mTLS dispatcher failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
    }
    this.logger.log(`Rebuilt ${this.agents.size} mTLS dispatcher(s) after a rotation.`);
  }

  private build(material: KeyMaterial): Map<string, Agent> {
    const agents = new Map<string, Agent>();
    for (const [origin, identity] of this.peers) {
      agents.set(origin, createPeerAgent(material, identity));
    }
    return agents;
  }
}

/**
 * One dispatcher for one peer.
 *
 * The `connect` options are the client half of the handshake: our certificate
 * and key, and the anchors the peer's certificate is verified against. Note
 * that `ca` *replaces* the public trust store for this dispatcher rather than
 * adding to it — which is what we want for an internal peer, and what makes a
 * dispatcher per peer the right unit.
 */
export function createPeerAgent(material: KeyMaterial, expectedIdentity: string): Agent {
  return new Agent({
    connect: {
      cert: material.cert,
      key: material.key,
      ca: [...material.ca],
      ...(material.passphrase === undefined ? {} : { passphrase: material.passphrase }),
      minVersion: "TLSv1.2",
      checkServerIdentity: (hostname, certificate) =>
        verifyPeerCertificate(expectedIdentity, hostname, certificate),
    },
  });
}

/**
 * Checks that the peer is who `MTLS_PEERS` says it is.
 *
 * Returning an `Error` rather than throwing is the contract `tls.connect`
 * documents; the error becomes the connection's failure.
 *
 * **Why the hostname check is conditional.** For a `DNS:` identity, the default
 * check is exactly right and is run as well — the name we dialled and the name
 * in the certificate must agree. For a SPIFFE id it cannot be: a SPIFFE leaf
 * carries a URI SAN and no DNS SAN at all, so `tls.checkServerIdentity` fails
 * every one of them. Skipping it there is not a weakening, because the URI has
 * to match exactly: the identity is a stronger statement than the hostname, and
 * it is the statement the mesh actually issues certificates about. A peer
 * reached through a shared gateway address — which is the case where the
 * hostname never matches anyway — is authenticated by that id and nothing else.
 */
export function verifyPeerCertificate(
  expectedIdentity: string,
  hostname: string,
  certificate: PeerCertificate,
): Error | undefined {
  const identities = peerIdentitiesFrom(certificate.subjectaltname);

  if (matchPeerIdentity(identities, [expectedIdentity]) === null) {
    return new Error(
      `The peer at ${hostname} presented ${
        identities.length === 0 ? "no URI or DNS SAN" : identities.join(", ")
      }, but MTLS_PEERS expects ${expectedIdentity}. Refusing the connection: a certificate ` +
        `signed by our CA proves the peer is in the trust domain, not that it is this peer.`,
    );
  }

  if (!expectedIdentity.includes("://")) {
    return checkHostname(hostname, certificate);
  }

  return undefined;
}
