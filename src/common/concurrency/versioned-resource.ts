/**
 * Marker key identifying a wrapped, versioned handler result.
 *
 * A string key rather than a `Symbol` or an `instanceof` check because the
 * value has to survive a JSON round trip. `HttpCacheInterceptor` is bound
 * *inside* `EntityTagInterceptor`, so on a cache hit the wrapper comes back
 * from the cache store — Redis, in any real deployment — where a class identity
 * and a symbol key both cease to exist. A cached response would then lose its
 * `ETag` and every conditional write against it would 428.
 */
export const VERSIONED_RESOURCE_MARKER = "__versionedResource";

/**
 * A handler result together with the version of the resource it represents.
 *
 * Wrapping is explicit rather than inferred from the payload. The obvious
 * alternative — "any object with a numeric `version` field gets an `ETag`" —
 * would attach validators to unrelated payloads that happen to carry that word
 * (a payment intent's API version, say), and a wrong `ETag` is worse than none:
 * it invites a conditional write against a validator the server never issued.
 */
export interface VersionedResource<T> {
  readonly [VERSIONED_RESOURCE_MARKER]: true;
  readonly version: number;
  readonly body: T;
}

/** Wraps `body` so `EntityTagInterceptor` emits an `ETag` for `version`. */
export function versioned<T>(body: T, version: number): VersionedResource<T> {
  return { [VERSIONED_RESOURCE_MARKER]: true, version, body };
}

export function isVersionedResource(value: unknown): value is VersionedResource<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate[VERSIONED_RESOURCE_MARKER] === true && typeof candidate["version"] === "number";
}
