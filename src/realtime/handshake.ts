import type { AuthenticatedUser, JwtPayload } from "@/auth/strategies/jwt.strategy";
import type { HandshakeRequest, HandshakeTokenVerifier } from "./ports";

/**
 * Where a handshake's bearer token came from.
 *
 * Recorded rather than discarded because the two carry different operational
 * risk and an operator reading a log line should be able to tell them apart —
 * see {@link readHandshakeCredentials} for what each costs.
 */
export type CredentialSource = "authorization-header" | "subprotocol";

/** Why a handshake was refused. Reported to the client as a close reason. */
export type HandshakeRejection =
  /** Nothing token-shaped anywhere in the upgrade request. */
  | "missing-credentials"
  /** An `Authorization` or `Sec-WebSocket-Protocol` header that is not the form this accepts. */
  | "malformed-credentials"
  /**
   * A token was offered in the query string, which this endpoint refuses on
   * purpose. Reported separately from `missing-credentials` because it is the
   * one rejection where the client is trying the wrong thing rather than
   * nothing, and a log line saying so saves an afternoon.
   */
  | "token-in-query"
  /** Signature, expiry, or algorithm check failed. */
  | "invalid-token"
  /** The signature verified but the claims are not a principal this build recognises. */
  | "unexpected-claims";

export interface HandshakeCredentials {
  readonly token: string;
  readonly source: CredentialSource;
}

export type CredentialLookup =
  | { readonly ok: true; readonly credentials: HandshakeCredentials }
  | { readonly ok: false; readonly rejection: HandshakeRejection };

export type HandshakeResult =
  | { readonly ok: true; readonly user: AuthenticatedUser; readonly source: CredentialSource }
  | { readonly ok: false; readonly rejection: HandshakeRejection };

/** The subprotocol a browser client offers first when the second value is its token. */
const BEARER_SUBPROTOCOL = "bearer";

/**
 * Query parameters that are conventionally used to smuggle a token, and are
 * refused here. Matched only to produce a better diagnosis than "missing".
 */
const TOKEN_QUERY_PARAMS = ["token", "access_token", "accessToken", "jwt", "authorization"];

/**
 * Pulls a bearer token out of an upgrade request.
 *
 * Two forms are accepted and a third is deliberately not.
 *
 * **`Authorization: Bearer <token>`** — what every non-browser client should
 * send, and what the rest of this API already expects.
 *
 * **`Sec-WebSocket-Protocol: bearer, <token>`** — the browser escape hatch.
 * The `WebSocket` constructor cannot set headers, which is the same constraint
 * `docs/streaming.md` describes for `EventSource`; unlike `EventSource` there
 * is a way out, because the constructor's second argument becomes this header:
 *
 * ```js
 * new WebSocket("wss://api.example.com/v1/realtime", ["bearer", accessToken]);
 * ```
 *
 * `ws` echoes the first offered subprotocol back in the response, so the
 * handshake completes with `bearer` selected and the token is never named in a
 * URL. That is the whole point of preferring it to the third form.
 *
 * **`?token=…`** — refused, and refused loudly. A query string is written to
 * every access log, proxy log and browser history entry on the path, and unlike
 * a header it survives in `Referer`. `docs/streaming.md` gives the same reason
 * for not offering it on the SSE route; a WebSocket has an alternative that SSE
 * does not, so here the refusal costs the client nothing.
 *
 * Note this reads the handshake only. It does not verify the token — that is
 * {@link authenticateHandshake}, kept separate so the parsing rules above can be
 * specified without a signing key.
 */
export function readHandshakeCredentials(request: HandshakeRequest): CredentialLookup {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    return match?.[1]
      ? { ok: true, credentials: { token: match[1], source: "authorization-header" } }
      : { ok: false, rejection: "malformed-credentials" };
  }

  const offered = request.headers["sec-websocket-protocol"];
  if (offered !== undefined) {
    const parts = offered
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");

    // Compared case-insensitively although RFC 6455 subprotocol tokens are
    // case-sensitive: the cost of accepting `Bearer` is nothing, and the cost
    // of rejecting it is a client that fails with "missing credentials" while
    // looking at a header that plainly contains its token.
    if (parts[0]?.toLowerCase() !== BEARER_SUBPROTOCOL) {
      return { ok: false, rejection: "malformed-credentials" };
    }
    // Exactly two values. A third is not a token this endpoint knows how to
    // read, and guessing which one to try is how a credential ends up being
    // matched by position against something that was never meant to be one.
    return parts.length === 2 && parts[1]
      ? { ok: true, credentials: { token: parts[1], source: "subprotocol" } }
      : { ok: false, rejection: "malformed-credentials" };
  }

  return {
    ok: false,
    rejection: hasTokenInQuery(request.url) ? "token-in-query" : "missing-credentials",
  };
}

/**
 * Verifies a handshake and turns it into the same principal the HTTP routes
 * carry.
 *
 * The claim check after `verify` is not belt-and-braces. `JwtService.verify`
 * establishes that *this* service signed the token and that it has not expired;
 * it says nothing about the shape of what was signed. Anything else this
 * application ever signs with `JWT_SECRET` would sail through — so the fields
 * `JwtStrategy.validate` reads are checked to be present and to be strings
 * before a principal is built from them, and a token that verifies but is not
 * an access token is rejected as `unexpected-claims` rather than becoming a
 * user with `id: undefined`.
 *
 * Deliberately synchronous. It runs between the upgrade completing and the
 * socket being either admitted or closed, and an `await` in that window is a
 * window in which an unauthenticated socket exists and can send frames.
 */
export function authenticateHandshake(
  request: HandshakeRequest,
  verifier: HandshakeTokenVerifier,
): HandshakeResult {
  const lookup = readHandshakeCredentials(request);
  if (!lookup.ok) return lookup;

  let claims: unknown;
  try {
    claims = verifier.verify(lookup.credentials.token);
  } catch {
    // The reason is deliberately not propagated to the client: "expired" and
    // "signature invalid" are the same instruction (get a new token) and the
    // difference is only ever useful to someone probing the endpoint.
    return { ok: false, rejection: "invalid-token" };
  }

  if (!isAccessTokenPayload(claims)) return { ok: false, rejection: "unexpected-claims" };

  return {
    ok: true,
    // The same three fields, read in the same order, as `JwtStrategy.validate`.
    // A WebSocket principal that differed from the HTTP one would make every
    // authorisation rule in the codebase mean two things.
    user: { id: claims.sub, email: claims.email, role: claims.role },
    source: lookup.credentials.source,
  };
}

function isAccessTokenPayload(claims: unknown): claims is JwtPayload {
  if (typeof claims !== "object" || claims === null) return false;
  const { sub, email, role } = claims as Record<string, unknown>;
  return (
    typeof sub === "string" && sub !== "" && typeof email === "string" && typeof role === "string"
  );
}

function hasTokenInQuery(url: string | undefined): boolean {
  if (url === undefined) return false;
  // The upgrade request's `url` is origin-form (`/v1/realtime?…`), so it needs a
  // base to parse. The base is discarded; only the query is read.
  const query = new URL(url, "ws://placeholder.invalid").searchParams;
  return TOKEN_QUERY_PARAMS.some((name) => query.has(name));
}
