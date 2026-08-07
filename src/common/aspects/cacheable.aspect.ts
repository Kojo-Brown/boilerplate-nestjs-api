import { AspectConfigurationError, assertPromiseLike, describeContext } from "./aspect.types";
import type { AspectContext, AspectInvocation, AspectLogger } from "./aspect.types";
import { buildDefaultCacheKey } from "./cache-key";
import type { AspectCacheStore } from "./ports";

export interface CacheableOptions {
  /** Entry lifetime in milliseconds. Omitted means the store's own default. */
  ttlMs?: number;
  /** Namespace prepended to the generated key. Ignored when `key` is given. */
  keyPrefix?: string;
  /**
   * Builds the key from the raw argument list. Needed when an argument cannot
   * be serialised deterministically — see {@link stableStringify} — or when
   * only part of it should take part in the key.
   */
  key?: (args: readonly unknown[]) => string;
}

export type ResolvedCacheableOptions = CacheableOptions;

export function resolveCacheableOptions(options: CacheableOptions = {}): ResolvedCacheableOptions {
  if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
    throw new AspectConfigurationError(
      `@Cacheable({ ttlMs }) must be a positive number of milliseconds, got ${options.ttlMs}.`,
    );
  }
  if (options.keyPrefix !== undefined && options.keyPrefix.length === 0) {
    throw new AspectConfigurationError("@Cacheable({ keyPrefix }) must not be empty.");
  }
  return options;
}

/**
 * Cached values are boxed so that a miss and a cached `undefined` can be told
 * apart: `store.get()` answers `undefined` for both, and without the box a
 * method that legitimately resolves to `undefined` would be re-executed on
 * every call while still paying for the lookup.
 */
interface CacheEnvelope {
  value: unknown;
}

export interface CacheableDependencies {
  readonly cache: AspectCacheStore;
  readonly logger: AspectLogger;
}

export function applyCacheable(
  next: AspectInvocation,
  context: AspectContext,
  options: ResolvedCacheableOptions,
  deps: CacheableDependencies,
): AspectInvocation {
  /**
   * Requests for a key whose first call has not come back yet.
   *
   * Without this, N concurrent cache misses for the same key are N calls to the
   * database — the stampede that a cold cache or an expiring hot entry produces
   * exactly when the system is least able to absorb it. Entries are removed as
   * soon as the underlying call settles, so nothing is retained here.
   */
  const inFlight = new Map<string, Promise<unknown>>();
  let keyFailureReported = false;
  let storeFailureReported = false;

  const report = (message: string, alreadyReported: boolean): boolean => {
    // The first occurrence is worth a warning; the rest of an outage is not,
    // and a cache degrading is not a reason to flood the logs.
    if (alreadyReported) deps.logger.debug(message);
    else deps.logger.warn(message);
    return true;
  };

  const read = async (key: string): Promise<CacheEnvelope | undefined> => {
    try {
      return await deps.cache.get<CacheEnvelope>(key);
    } catch (error) {
      storeFailureReported = report(
        describeFailure("read", context, key, error),
        storeFailureReported,
      );
      return undefined;
    }
  };

  const write = async (key: string, value: unknown): Promise<void> => {
    try {
      await deps.cache.set<CacheEnvelope>(key, { value }, options.ttlMs);
    } catch (error) {
      storeFailureReported = report(
        describeFailure("write", context, key, error),
        storeFailureReported,
      );
    }
  };

  const load = async (key: string, args: readonly unknown[]): Promise<unknown> => {
    const hit = await read(key);
    if (hit) return hit.value;

    const pending = inFlight.get(key);
    if (pending) return await pending;

    const promise = (async () => {
      const result = next(args);
      assertPromiseLike(result, context, "Cacheable");
      const value = await result;
      // Only successful calls are stored. Caching a rejection would turn one
      // upstream blip into a `ttlMs`-long outage for every caller.
      await write(key, value);
      return value;
    })();

    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  };

  return (args) => {
    let key: string;
    try {
      key = options.key
        ? options.key(args)
        : buildDefaultCacheKey(context, args, options.keyPrefix);
    } catch (error) {
      // A cache may never turn a working call into a failing one, so an
      // unkeyable argument list bypasses the cache instead of throwing.
      keyFailureReported = report(
        JSON.stringify({
          aspect: "cacheable",
          method: describeContext(context),
          event: "bypassed",
          reason: error instanceof Error ? error.message : String(error),
        }),
        keyFailureReported,
      );
      return next(args);
    }
    return load(key, args);
  };
}

function describeFailure(
  operation: "read" | "write",
  context: AspectContext,
  key: string,
  error: unknown,
): string {
  return JSON.stringify({
    aspect: "cacheable",
    method: describeContext(context),
    event: `${operation}-failed`,
    key,
    error: error instanceof Error ? error.message : String(error),
  });
}
