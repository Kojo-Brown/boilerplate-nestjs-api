/**
 * Where the idempotency module keeps what it has seen.
 *
 * Declared here rather than in `config/env.schema.ts` so the module owns its
 * own vocabulary and the config layer imports it — the same arrangement
 * `STORAGE_ADAPTER_NAMES` and `PAYMENT_PROVIDER_NAMES` use.
 */
export const IDEMPOTENCY_STORE_NAMES = ["redis", "memory"] as const;

export type IdempotencyStoreName = (typeof IDEMPOTENCY_STORE_NAMES)[number];

/** Injection token for the selected {@link IdempotencyStore}. */
export const IDEMPOTENCY_STORE = Symbol("IDEMPOTENCY_STORE");

/**
 * The bytes a replay has to reproduce.
 *
 * The body is kept as the string that went on the wire rather than as a parsed
 * object, because a replay has to be indistinguishable from the original
 * response — re-serialising a decoded object would reorder keys, drop the
 * exact number formatting, and quietly change `Content-Length`.
 */
export interface RecordedResponse {
  readonly status: number;
  /** Verbatim `Content-Type`, or `null` for a body-less response (204, 304). */
  readonly contentType: string | null;
  /** Verbatim response body, or `null` when the handler wrote none. */
  readonly body: string | null;
}

interface RecordBase {
  /**
   * Hash of the request that claimed this key. A second request presenting the
   * same key with a different fingerprint is a client bug — two distinct
   * operations sharing a key — and is refused rather than answered with the
   * first one's response.
   */
  readonly fingerprint: string;
  /**
   * Randomly generated per request, and required to `complete` or `release`.
   *
   * It is a fencing token. If a request outlives the record's TTL, a retry can
   * reserve the same key while the original is still running; without a lease
   * the original's late `release()` would delete the retry's reservation and
   * let a *third* attempt execute concurrently. Holding the lease means only
   * the request that reserved the key can resolve it, and a late finisher's
   * write is dropped instead of clobbering a newer one.
   */
  readonly lease: string;
}

/** Reserved, handler still running. A concurrent retry gets 409. */
export interface InFlightRecord extends RecordBase {
  readonly state: "in-flight";
}

/** Handler finished; `response` is what every later retry receives. */
export interface CompletedRecord extends RecordBase {
  readonly state: "completed";
  readonly response: RecordedResponse;
}

export type IdempotencyRecord = InFlightRecord | CompletedRecord;

/**
 * The dedupe store, as `IdempotencyInterceptor` sees one.
 *
 * Only `reserve` has to be atomic, and it is the whole reason this is a port
 * rather than a `Map` behind the interceptor: two replicas receiving the same
 * retry at the same moment must not both decide they are the first. Redis
 * settles that with `SET NX`; the in-memory implementation settles it with the
 * event loop, which is why it is honest only for a single process (see
 * `InMemoryIdempotencyStore`).
 */
export interface IdempotencyStore {
  /**
   * Claims `key` for this request.
   *
   * Returns `null` when the caller now owns the key and must run the handler,
   * or the record already stored under it — in flight or completed — when
   * someone else got there first.
   */
  reserve(key: string, record: InFlightRecord, ttlMs: number): Promise<IdempotencyRecord | null>;

  /**
   * Stores the response every later retry replays, and restarts the TTL.
   *
   * Returns `false` when the key is gone or has been re-reserved under a
   * different lease, which means this response is stale and must not be
   * recorded.
   */
  complete(key: string, lease: string, response: RecordedResponse, ttlMs: number): Promise<boolean>;

  /**
   * Drops a reservation this caller holds, so the operation can be retried.
   *
   * Used when the request produced nothing worth replaying — a 5xx, a dropped
   * connection, a streamed body. Returns `false` if the lease no longer
   * matches, for the same reason `complete` does.
   */
  release(key: string, lease: string): Promise<boolean>;

  /** Reads a record without claiming anything. For diagnostics and tests. */
  get(key: string): Promise<IdempotencyRecord | null>;
}
