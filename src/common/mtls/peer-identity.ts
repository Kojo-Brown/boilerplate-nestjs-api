import type { X509Certificate } from "node:crypto";

/**
 * Reading a peer's identity out of its certificate, and deciding whether that
 * identity is one we talk to.
 *
 * The identity is a SAN entry — a `URI:` (a SPIFFE id, in a mesh) or a `DNS:`
 * name — and never the subject common name. A CN is free text that no issuer
 * constrains: name constraints, the extension a CA uses to limit what it will
 * vouch for, apply to the SAN. Matching on a CN in 2026 means matching on a
 * field the CA never promised anything about, which is why every profile that
 * still mentions it (RFC 6125 §6.4.4, the CA/Browser Forum baseline
 * requirements) has deprecated it for identification.
 */

/** One SAN entry, with the type prefix OpenSSL wrote and the value it carried. */
export interface SubjectAltNameEntry {
  /** `URI`, `DNS`, `IP Address`, `email`, `othername` — exactly as Node renders it. */
  readonly kind: string;
  readonly value: string;
}

/** The two SAN types this service accepts as an identity. */
const IDENTITY_KINDS = new Set(["URI", "DNS"]);

/** `MTLS_ALLOWED_CLIENTS=*`: any peer the trust anchor vouches for. */
export const ANY_PEER = "*";

/**
 * Parses `X509Certificate.subjectAltName`, returning `null` when the string is
 * not in the form Node produces.
 *
 * **Why this is not a `split(", ")`.** A SAN value is attacker-influenced: it is
 * whatever the peer asked its CA to sign. Node knows this, and quotes any entry
 * whose value would otherwise be ambiguous — a certificate carrying
 *
 * ```
 * DNS:evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders
 * ```
 *
 * as a *single* DNS name comes back as
 *
 * ```
 * DNS:"evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders"
 * ```
 *
 * with the comma escaped inside a JSON string literal. A parser that splits on
 * `", "` and strips quotes reads that as two entries and hands an allowlist
 * check the identity of a service the peer has no key for. The real certificate
 * is in `peer-identity.spec.ts`, issued by `test-certificates.ts`, because this
 * is not a case anybody invents from the documentation.
 *
 * `null` rather than a partial list when the string does not parse: a SAN we
 * cannot read is a peer we cannot identify, and the caller denies it. Returning
 * what was understood so far would be the same mistake in a different place.
 */
export function parseSubjectAltName(raw: string | null | undefined): SubjectAltNameEntry[] | null {
  if (raw === null || raw === undefined) return [];
  if (raw.length === 0) return [];

  const entries: SubjectAltNameEntry[] = [];
  let index = 0;

  while (index < raw.length) {
    const separator = raw.indexOf(":", index);
    if (separator === -1) return null;

    const kind = raw.slice(index, separator);
    // A type prefix is a short ASCII label. Anything holding a quote or a comma
    // means we have lost the frame and are reading a value as a type.
    if (kind.length === 0 || /["',]/.test(kind)) return null;
    index = separator + 1;

    let value: string;
    if (raw[index] === '"') {
      const end = endOfQuotedValue(raw, index);
      if (end === -1) return null;
      const parsed: unknown = safeJsonParse(raw.slice(index, end));
      if (typeof parsed !== "string") return null;
      value = parsed;
      index = end;
    } else {
      // An unquoted value cannot contain a comma: Node quotes anything that
      // would need escaping, and a comma is on that list. So a comma here is a
      // separator, and one that is not followed by a space means this is not a
      // string Node wrote — which is a frame we have lost rather than a value
      // with punctuation in it.
      const next = raw.indexOf(", ", index);
      value = next === -1 ? raw.slice(index) : raw.slice(index, next);
      if (value.includes(",")) return null;
      index = next === -1 ? raw.length : next;
    }

    entries.push({ kind, value });

    if (index < raw.length) {
      if (!raw.startsWith(", ", index)) return null;
      index += 2;
    }
  }

  return entries;
}

/**
 * The identities in a SAN string: every `URI:` and `DNS:` value, in the order
 * the certificate lists them.
 *
 * An unparseable SAN yields an empty list — the same answer as a certificate
 * with no SAN at all, which is the answer that denies the peer.
 */
export function peerIdentitiesFrom(raw: string | null | undefined): string[] {
  const entries = parseSubjectAltName(raw);
  if (entries === null) return [];
  return entries.filter((entry) => IDENTITY_KINDS.has(entry.kind)).map((entry) => entry.value);
}

/** The identities in a parsed certificate. */
export function certificateIdentities(certificate: X509Certificate): string[] {
  return peerIdentitiesFrom(certificate.subjectAltName);
}

/**
 * Whether `value` is something a certificate could actually carry as an
 * identity, for validating `MTLS_ALLOWED_CLIENTS` and `MTLS_PEERS` at boot.
 *
 * Deliberately narrow, for the reason `isSerialisedOrigin` is: an allowlist
 * entry that matches nothing does not fail — it denies every peer, for every
 * request, while looking exactly like a configured allowlist. A wildcard
 * (`*.internal`) is the common way to write one, and there is no wildcard
 * matching here to make it mean anything.
 */
export function isPeerIdentity(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false;
  if (value.includes("*")) return false;

  if (value.includes("://")) {
    // A URI SAN is matched against byte for byte, so the only question here is
    // whether it is a URI at all. Deliberately *not* a round trip against
    // `url.href`: `URL` appends the empty path that makes
    // `https://orders.internal` into `https://orders.internal/`, and a SPIFFE
    // id is all path — normalising either way would reject the form the
    // certificate actually carries.
    try {
      const url = new URL(value);
      // A scheme with nothing after it names no workload. `spiffe://` parses
      // happily — non-special schemes are allowed an empty authority — and
      // would sit in an allowlist matching nothing.
      return url.protocol.length > 0 && (url.host.length > 0 || url.pathname.length > 0);
    } catch {
      return false;
    }
  }

  return isDnsName(value);
}

/** A hostname, as a `DNS:` SAN carries one. No wildcards, no trailing dot. */
function isDnsName(value: string): boolean {
  if (value.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value);
}

/** Whether an allowlist is the "anyone the CA vouches for" wildcard. */
export function allowsAnyPeer(allowlist: readonly string[]): boolean {
  return allowlist.length === 1 && allowlist[0] === ANY_PEER;
}

/**
 * The first identity in `identities` that appears in `allowlist`, or `null`.
 *
 * A `DNS:` name is matched case-insensitively because the DNS is; a URI is
 * matched byte for byte, because a SPIFFE id's path is case-sensitive and two
 * ids differing only in case are two different workloads.
 */
export function matchPeerIdentity(
  identities: readonly string[],
  allowlist: readonly string[],
): string | null {
  for (const identity of identities) {
    for (const allowed of allowlist) {
      if (identity === allowed) return identity;
      if (
        !identity.includes("://") &&
        !allowed.includes("://") &&
        identity.toLowerCase() === allowed.toLowerCase()
      ) {
        return identity;
      }
    }
  }
  return null;
}

/** Splits a comma-separated list the way every list in the environment is split. */
export function parseIdentityList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Index of the character after the closing quote, or -1 if there is none. */
function endOfQuotedValue(raw: string, start: number): number {
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === '"') return index + 1;
  }
  return -1;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
