import { createHash } from "node:crypto";
import type { Request } from "express";

/** The header clients send, as named by draft-ietf-httpapi-idempotency-key-header. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Set on a response served from the store rather than from the handler.
 *
 * The draft defines no such header, so this follows the de-facto spelling
 * (Stripe's `Idempotent-Replayed`, hyphenated to match the request header).
 * Clients should not need it — the whole point is that a replay is
 * indistinguishable — but it is the difference between a support ticket that
 * takes five minutes and one that takes a day.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

/**
 * Long enough for a UUID, an ULID, or a client's own request id, and short
 * enough that a key cannot be used to push megabytes into Redis. Stripe caps at
 * 255 for the same reason.
 */
export const MAX_KEY_LENGTH = 255;

/**
 * Methods a key is honoured on.
 *
 * `GET`, `HEAD` and `OPTIONS` are already idempotent by definition, so
 * recording and replaying them would add a Redis round trip and a cache with
 * none of the safety — and would silently shadow the `Cache-Control` story the
 * `HttpCacheInterceptor` already owns.
 */
const REPLAYABLE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isReplayableMethod(method: string): boolean {
  return REPLAYABLE_METHODS.has(method.toUpperCase());
}

/**
 * Rejects keys that are empty, over-long, or carry anything but printable
 * ASCII.
 *
 * Keys end up in a Redis key and in logs, so control characters and newlines
 * are refused outright rather than escaped — there is no legitimate client that
 * needs them, and a key containing `\r\n` is a log-injection primitive.
 */
export function isValidKey(key: string): boolean {
  return key.trim().length > 0 && key.length <= MAX_KEY_LENGTH && /^[\x20-\x7e]+$/.test(key);
}

/**
 * Who a key belongs to.
 *
 * Keys are namespaced per caller, not globally, because a global namespace
 * would let anyone replay someone else's response simply by guessing their key
 * — and the response body is exactly the thing worth stealing. An
 * authenticated request is scoped to its user; an unauthenticated one falls
 * back to the client address, which is weaker (two clients behind one NAT share
 * a namespace) but still bounded, and the fingerprint check below catches the
 * collision that matters.
 */
export function callerScope(req: Request): string {
  const user = (req as Request & { user?: { id?: string } }).user;
  return user?.id ? `user:${user.id}` : `ip:${req.ip ?? "unknown"}`;
}

/**
 * Identifies the *operation* a key was used for.
 *
 * A client that reuses one key for two different requests has a bug, and
 * answering the second with the first one's response would turn that bug into
 * silent data loss. Hashing the request lets the second one be refused
 * instead.
 *
 * What goes in is everything the server can see cheaply and deterministically:
 * the method, the full path with its query string, the content type, the
 * declared length, and the parsed body. What does *not* go in is the raw bytes
 * of a `multipart/form-data` upload — they are consumed by the file parser
 * before this runs, so two different files posted under one key are
 * distinguished only by `Content-Length`. Two uploads of identical length under
 * a single key will replay the first. See docs/idempotency.md.
 */
export function fingerprint(req: Request): string {
  const body =
    req.body === undefined || req.body === null ? "" : stableStringify(req.body as unknown);

  return createHash("sha256")
    .update(
      [
        req.method.toUpperCase(),
        req.originalUrl,
        req.headers["content-type"] ?? "",
        req.headers["content-length"] ?? "",
        body,
      ].join("\n"),
    )
    .digest("hex");
}

/** The Redis key a request's record lives under. */
export function storeKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

/**
 * Serialises with object keys sorted, so a client that re-encodes its retry
 * with a different property order is still recognised as the same request.
 *
 * `JSON.stringify` preserves insertion order, and insertion order comes from
 * the order the fields appeared in the request body — which nothing obliges a
 * client to keep stable across a retry, least of all one assembling the body
 * from a map.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}
