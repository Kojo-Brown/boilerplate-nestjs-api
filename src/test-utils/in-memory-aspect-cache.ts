import type { AspectCacheStore } from "@/common/aspects";

/**
 * An `AspectCacheStore` backed by a `Map`, with the failure modes a real store
 * has: `failReads` and `failWrites` make it throw so a test can prove that
 * `@Cacheable()` degrades to calling through rather than failing the request.
 *
 * TTLs are recorded rather than enforced — nothing here expires on its own, and
 * a test that wants an expiry calls `clear()`.
 */
export class InMemoryAspectCache implements AspectCacheStore {
  readonly entries = new Map<string, unknown>();
  readonly ttls = new Map<string, number | undefined>();
  reads = 0;
  writes = 0;
  failReads = false;
  failWrites = false;

  get<T>(key: string): Promise<T | undefined> {
    this.reads += 1;
    if (this.failReads) return Promise.reject(new Error("cache read failed"));
    return Promise.resolve(this.entries.get(key) as T | undefined);
  }

  set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.writes += 1;
    if (this.failWrites) return Promise.reject(new Error("cache write failed"));
    this.entries.set(key, value);
    this.ttls.set(key, ttlMs);
    return Promise.resolve();
  }

  clear(): void {
    this.entries.clear();
    this.ttls.clear();
  }
}
