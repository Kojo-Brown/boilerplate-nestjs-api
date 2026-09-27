import { REDACTED } from "./log-event";

/**
 * Removes credentials from a string the allowlist has already decided to keep.
 *
 * ### Why there is a second layer at all
 *
 * The allowlist decides *which fields* are logged. It cannot decide what is
 * inside one. `path` is allowlisted because an access log without a path is
 * not an access log — and `path` is where this service's worst leak lived:
 * `/v1/auth/google/callback?code=4/0AX…` is a single-use authorisation code
 * exchangeable for that person's tokens, written to stdout on every successful
 * sign-in. No allowlist can catch that, because the field is one somebody was
 * right to allow.
 *
 * So: the allowlist gates fields, and this gates the contents of the fields
 * that survive it. Both are needed and neither is sufficient.
 *
 * ### Why this is not a PII detector
 *
 * It deliberately matches **credentials**, not personal data. Detecting PII by
 * pattern is a losing game — a name matches nothing, an address matches
 * everything, and a regex that finds 90% of email addresses is a control that
 * fails silently one time in ten while reading as if it works. PII is the
 * allowlist's job, where the default is exposure-by-review rather than
 * detection-by-luck.
 *
 * A credential is the opposite case and the patterns below are chosen for it:
 * each has a structural marker that is close to unmistakable, and the cost of a
 * false positive is one unreadable value in a log line while the cost of a miss
 * is an account.
 */

/**
 * The value half of a `key=value` pair in a query string or a URL fragment.
 *
 * Every value is scrubbed and every **name** is kept, which is the useful half
 * of the trade: `?code=[redacted]&state=[redacted]` tells an operator exactly
 * which parameters arrived without telling them what was in any of them. The
 * alternative — a list of parameter names known to be sensitive — is the
 * denylist this module exists to avoid, and `code` would not have been on it
 * until the day after it mattered.
 *
 * Query parameters that are genuinely navigation are recovered in the access log
 * by parsing them into a `query` object, where the allowlist admits `query.page`
 * and friends by name. That is the right place for the exception: a named
 * decision in the allowlist, not a pattern that has to guess.
 */
const QUERY_PAIR = /([?&#][^=&#\s]+=)[^&#\s]+/g;

/**
 * A compact JWS — three base64url segments separated by dots, the middle one
 * starting with the `eyJ` that every JSON object's base64 begins with.
 *
 * Anchored on that prefix rather than on "three dotted base64 runs", which also
 * describes a version string, a package name and a stack frame. A JWT is worth
 * this precision: it is a bearer credential, so logging one hands over the
 * session it represents, and the header and payload are not even encrypted —
 * whoever reads the line reads the claims.
 */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g;

/**
 * A PEM private key or certificate request block, collapsed to its header.
 *
 * Reachable from here: `KeyMaterialService` names files and reports why a pair
 * did not match, `local-master-key.key-provider.ts` reads key material from the
 * environment, and an error thrown while parsing either can carry the buffer it
 * failed on. A key that reaches a log is a key that has to be rotated, and the
 * block is unmistakable, so the match is cheap and certain.
 */
const PEM_BLOCK = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

/**
 * An `Authorization`-style credential after its scheme.
 *
 * The scheme is kept because it is diagnostic — `Basic` where `Bearer` was
 * expected is the whole answer to some failures — and the material after it
 * never is. Matches a bare `Bearer …` in free text too, which is where it
 * usually appears: interpolated into an error message by a client library.
 */
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** How long a single scrubbed string may be before it is cut. */
export const MAX_STRING_LENGTH = 2048;

/**
 * Scrubs one string.
 *
 * Order matters: the PEM block first, because its body contains base64 runs
 * that the JWT and scheme patterns would otherwise chew through one line at a
 * time, turning one match into fifty. The length cap is applied **after**
 * scrubbing, so a credential near the end of a long string is removed rather
 * than merely pushed past the cut.
 */
export function scrubSecrets(value: string): string {
  const scrubbed = value
    .replace(PEM_BLOCK, (_match, label: string) => `-----BEGIN ${label}----- ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(QUERY_PAIR, (_match, prefix: string) => `${prefix}${REDACTED}`);

  if (scrubbed.length <= MAX_STRING_LENGTH) return scrubbed;
  // The marker goes on the end so the line stays valid JSON and an operator can
  // tell a cut string from a short one. Nothing tries to record the original
  // length: see `REDACTED` on why a length is not free.
  return `${scrubbed.slice(0, MAX_STRING_LENGTH)}…${REDACTED}`;
}
