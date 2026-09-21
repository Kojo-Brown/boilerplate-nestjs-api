import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";
import { certificateIdentities } from "./peer-identity";

/**
 * Loading and validating the key material this service presents, and the trust
 * anchors it verifies peers against.
 *
 * Everything here is checked at load time rather than at handshake time, and
 * that is the whole point of the file. A certificate that does not match its
 * key, a leaf that does not chain to the CA bundle beside it, a file that was
 * replaced with an empty one by a half-finished rotation: every one of those
 * produces a TLS alert on somebody else's socket, in a handshake that never got
 * far enough to log anything useful on either end. `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`
 * in a caller's logs is the *only* symptom of a trust bundle that was rotated
 * without its leaf, and it names neither the file nor the service that is wrong.
 *
 * So the material is parsed, cross-checked and dated here, where a failure can
 * say which file it read and what it expected to find in it.
 */

/** Where the material lives on disk. Three files, as every mesh and secret store mounts them. */
export interface KeyMaterialFiles {
  /** The leaf certificate, optionally followed by the intermediates that chain it. */
  readonly certFile: string;
  /** The private key for the leaf. */
  readonly keyFile: string;
  /** The trust anchors peers are verified against. One or more certificates. */
  readonly caFile: string;
}

/** Loaded, validated material — everything the TLS layer and the operator need. */
export interface KeyMaterial {
  /** The certificate chain PEM, verbatim, as `tls` wants it. */
  readonly cert: string;
  readonly key: string;
  /** The trust anchors, split so `tls` verifies against each rather than the blob. */
  readonly ca: readonly string[];
  readonly passphrase?: string;
  /** The leaf, parsed — the source of every field below. */
  readonly leaf: X509Certificate;
  /** The leaf's `URI:`/`DNS:` SAN values: what a peer will know this service as. */
  readonly identities: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
  /**
   * The earliest expiry in the whole set, leaf and anchors alike.
   *
   * The anchors are in here because a CA outliving nothing is the failure that
   * arrives without warning: every leaf it ever issued stays valid, every
   * handshake starts failing on the same afternoon, and no leaf's expiry date
   * says anything about it.
   */
  readonly expiresAt: Date;
  /** SHA-256 of the leaf and every anchor: what "the material changed" means. */
  readonly fingerprint: string;
}

/** A load that could not produce usable material. Always names the file it read. */
export class KeyMaterialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KeyMaterialError";
  }
}

export interface LoadKeyMaterialOptions {
  /** Injected so the validity window can be tested without waiting a day. */
  readonly now: Date;
  /** Decrypts an encrypted private key. From the environment, never from a file. */
  readonly passphrase?: string;
}

/** How many intermediates a chain may have before we call it a loop. */
const MAX_CHAIN_DEPTH = 8;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Reads the three files and returns material that is known to work, or throws
 * {@link KeyMaterialError} explaining which check failed.
 *
 * The checks run in the order a mistake is usually made: the files exist, they
 * hold certificates, the key belongs to the certificate, the certificate is
 * within its validity window, and the certificate chains to something in the CA
 * bundle.
 */
export function loadKeyMaterial(
  files: KeyMaterialFiles,
  options: LoadKeyMaterialOptions,
): KeyMaterial {
  const cert = readMaterialFile(files.certFile, "certificate");
  const key = readMaterialFile(files.keyFile, "private key");
  const caBundle = readMaterialFile(files.caFile, "trust anchor");

  const chain = parseCertificates(cert, files.certFile);
  const anchors = parseCertificates(caBundle, files.caFile);
  const leaf = chain[0];
  if (leaf === undefined) {
    throw new KeyMaterialError(
      `${files.certFile} contains no PEM certificate block. A DER file, a key written to the ` +
        `wrong path, or an empty file left by an interrupted rotation all look like this.`,
    );
  }

  assertKeyMatchesCertificate(cert, key, options.passphrase, files);

  const notBefore = certificateDate(leaf, "validFromDate", files.certFile);
  const notAfter = certificateDate(leaf, "validToDate", files.certFile);

  if (options.now < notBefore) {
    throw new KeyMaterialError(
      `The certificate in ${files.certFile} is not valid until ${notBefore.toISOString()}, ` +
        `which is in the future. Every peer will reject this handshake until then — usually ` +
        `this is a clock that has not been synchronised rather than a certificate that is wrong.`,
    );
  }

  if (options.now > notAfter) {
    throw new KeyMaterialError(
      `The certificate in ${files.certFile} expired at ${notAfter.toISOString()}. Refusing it ` +
        `here rather than presenting it: every peer would reject the handshake, and an ` +
        `expired certificate is the one failure that is cheaper to find at startup than in ` +
        `four services' error logs at once.`,
    );
  }

  if (!chainsToAnchor(leaf, chain.slice(1), anchors)) {
    throw new KeyMaterialError(
      `The certificate in ${files.certFile} does not chain to any anchor in ${files.caFile}. ` +
        `A leaf rotated without its trust bundle (or the other way round) fails exactly like ` +
        `this, and at handshake time the only evidence is an "unknown CA" alert in the ` +
        `caller's logs, which names neither file.`,
    );
  }

  const anchorExpiries = anchors.map((anchor) =>
    certificateDate(anchor, "validToDate", files.caFile),
  );

  return {
    cert,
    key,
    ca: anchors.map((anchor) => anchor.toString()),
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    leaf,
    identities: certificateIdentities(leaf),
    notBefore,
    notAfter,
    expiresAt: earliest([notAfter, ...anchorExpiries]),
    fingerprint: [leaf, ...anchors].map((certificate) => certificate.fingerprint256).join("+"),
  };
}

/** Milliseconds until the material stops working, negative once it has. */
export function millisecondsUntilExpiry(material: KeyMaterial, now: Date): number {
  return material.expiresAt.getTime() - now.getTime();
}

/** A line for the log: who we are, until when, and which material this is. */
export function describeKeyMaterial(material: KeyMaterial): string {
  const identities =
    material.identities.length > 0 ? material.identities.join(", ") : "<no URI or DNS SAN>";
  return (
    `identities=[${identities}] notAfter=${material.notAfter.toISOString()} ` +
    `expires=${material.expiresAt.toISOString()} fingerprint=${material.fingerprint}`
  );
}

/**
 * Whether `leaf` chains to one of `anchors`, walking through `intermediates`.
 *
 * `checkIssued` compares names and key identifiers; `verify` checks the
 * signature. Both, because the first is a claim and the second is the evidence
 * for it — a certificate can name an issuer whose key never signed it.
 */
function chainsToAnchor(
  leaf: X509Certificate,
  intermediates: readonly X509Certificate[],
  anchors: readonly X509Certificate[],
): boolean {
  let current = leaf;
  const used = new Set<string>();

  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth += 1) {
    if (anchors.some((anchor) => isIssuedBy(current, anchor))) return true;

    const next = intermediates.find(
      (candidate) => !used.has(candidate.fingerprint256) && isIssuedBy(current, candidate),
    );
    if (next === undefined) return false;

    used.add(next.fingerprint256);
    current = next;
  }

  return false;
}

function isIssuedBy(certificate: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
  } catch {
    // `verify` throws rather than returning false for a key type it cannot use
    // — a chain we cannot check is one we have not checked.
    return false;
  }
}

/**
 * Proves the key and the certificate belong together, by building the same
 * secure context the TLS server will.
 *
 * There is no cheaper check: comparing public keys would miss an encrypted key
 * with the wrong passphrase, and OpenSSL is the party that has to agree anyway.
 * Doing it here means a mismatched pair is a startup error rather than an
 * `ERR_SSL_KEY_VALUES_MISMATCH` thrown from inside `https.createServer` at the
 * first connection.
 */
function assertKeyMatchesCertificate(
  cert: string,
  key: string,
  passphrase: string | undefined,
  files: KeyMaterialFiles,
): void {
  try {
    createSecureContext({ cert, key, ...(passphrase === undefined ? {} : { passphrase }) });
  } catch (cause) {
    const code = (cause as { code?: string } | undefined)?.code ?? "";
    const hint = /DECRYPT|PASSWORD|PASSPHRASE/i.test(code)
      ? `The key looks encrypted and MTLS_KEY_PASSPHRASE ${
          passphrase === undefined ? "is not set" : "did not decrypt it"
        }.`
      : `The private key in ${files.keyFile} does not match the certificate in ${files.certFile}.`;
    throw new KeyMaterialError(
      `${hint} OpenSSL reported ${code === "" ? "no error code" : code}.`,
      { cause },
    );
  }
}

function parseCertificates(pem: string, path: string): X509Certificate[] {
  const blocks = pem.match(PEM_CERTIFICATE) ?? [];
  return blocks.map((block, index) => {
    try {
      return new X509Certificate(block);
    } catch (cause) {
      throw new KeyMaterialError(
        `Certificate ${index + 1} in ${path} is not a certificate this runtime can parse.`,
        { cause },
      );
    }
  });
}

function certificateDate(
  certificate: X509Certificate,
  field: "validFromDate" | "validToDate",
  path: string,
): Date {
  const value = certificate[field];
  // Typed as possibly undefined: the field is absent on a certificate whose
  // dates OpenSSL could not represent. That is not material we should present.
  if (value === undefined) {
    throw new KeyMaterialError(
      `The certificate in ${path} has no readable ${
        field === "validFromDate" ? "notBefore" : "notAfter"
      } date.`,
    );
  }
  return value;
}

function earliest(dates: readonly Date[]): Date {
  return dates.reduce((soonest, date) => (date < soonest ? date : soonest));
}

function readMaterialFile(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    const code = (cause as { code?: string } | undefined)?.code;
    throw new KeyMaterialError(
      `Cannot read the ${what} file ${path}${code === undefined ? "" : ` (${code})`}. ` +
        `In a mesh this path is a mounted secret: check that the volume is mounted and that ` +
        `the process user can read it.`,
      { cause },
    );
  }
}
