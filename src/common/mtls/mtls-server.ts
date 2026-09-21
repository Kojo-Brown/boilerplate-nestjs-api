import type { SecureContextOptions, Server as TlsServer } from "node:tls";
import type { MtlsEnv } from "./mtls.env";
import type { KeyMaterial } from "./key-material";
import type { MtlsKeyMaterialService } from "./key-material.service";

/**
 * The TLS options this service listens with, and how they are replaced when
 * the material rotates.
 */

/** What `NestFactory.create({ httpsOptions })` is handed. */
export type MtlsServerOptions = SecureContextOptions & {
  readonly requestCert: boolean;
  readonly rejectUnauthorized: boolean;
};

/**
 * Builds the listener's TLS options from loaded material.
 *
 * `requestCert` is always on — without it the server never asks for a client
 * certificate and `socket.getPeerCertificate()` is an empty object, so every
 * peer is anonymous no matter what the guard does.
 *
 * `rejectUnauthorized` is the interesting one, and it is where the probe
 * trade-off lands. On (the default), OpenSSL ends the handshake itself for a
 * peer whose certificate does not chain to `ca`: nothing reaches Node, which is
 * the cheapest possible refusal and the one that cannot be undone by a bug
 * further up. Off, the handshake completes and `socket.authorized` carries the
 * verdict — which is what {@link MtlsPeerGuard} reads, and the only arrangement
 * in which an exempt health-check path is reachable by a kubelet that has no
 * certificate to present.
 *
 * `minVersion` is 1.2 rather than 1.3: 1.3 would be better, and the client
 * certificate exchange in 1.3 happens after the server's Finished message,
 * which changes when a rejection is observed and breaks peers still on an older
 * OpenSSL. 1.2 is the floor every TLS stack in service today clears, and a
 * deployment where every peer is 1.3-capable can raise it in one line.
 */
export function buildMtlsServerOptions(material: KeyMaterial, env: MtlsEnv): MtlsServerOptions {
  return {
    ...secureContextFrom(material),
    requestCert: true,
    rejectUnauthorized: !env.MTLS_ALLOW_UNAUTHENTICATED_PROBES,
    minVersion: "TLSv1.2",
  };
}

/**
 * The subset of the options that a running server can be given later.
 *
 * `setSecureContext` replaces the key, certificate and anchors and nothing
 * else: `requestCert` and `rejectUnauthorized` are properties of the server,
 * fixed when it was created. Worth knowing before planning a rotation that
 * also changes one of them — that one needs a new listener, not a new context.
 */
export function secureContextFrom(material: KeyMaterial): SecureContextOptions {
  return {
    cert: material.cert,
    key: material.key,
    ca: [...material.ca],
    ...(material.passphrase === undefined ? {} : { passphrase: material.passphrase }),
  };
}

/**
 * Keeps a listening server's certificate in step with the material.
 *
 * Returns the unsubscribe function.
 *
 * The swap affects connections established after it. An existing connection
 * keeps the context it was negotiated with — which is correct, and is why a
 * rotation is not a reason to drop anybody: the peer on the other end verified
 * the certificate it was shown when it was shown, and nothing about that
 * becomes false when a newer one is issued. It does mean a revocation is not
 * complete until those connections end, which is what `docs/mtls.md` says to do
 * about it.
 */
export function attachSecureContextRotation(
  server: Pick<TlsServer, "setSecureContext">,
  material: MtlsKeyMaterialService,
): () => void {
  return material.onRotate((rotated) => {
    server.setSecureContext(secureContextFrom(rotated));
  });
}
