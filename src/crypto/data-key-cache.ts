import { Logger } from "@nestjs/common";
import { fieldName } from "./encrypted-field";
import type { EncryptedField } from "./encrypted-field";
import type { DataKey } from "./ports";

/** Where the cache gets material it does not have. Implemented by the service. */
export interface DataKeySource {
  mint(field: EncryptedField): Promise<DataKey>;
  unwrap(field: EncryptedField, wrapped: Buffer): Promise<Buffer>;
}

export interface DataKeyCacheOptions {
  /** How long a data key may be used for, and how long an unwrapped one is kept. */
  readonly ttlMs: number;
  /** How many values one data key may encrypt before it is retired. */
  readonly maxUses: number;
  /** How many distinct wrapped keys to keep unwrapped. */
  readonly maxDecryptEntries: number;
  /**
   * When to start replacing the active key, as a fraction of its budget.
   *
   * 0.8 means a key is replaced in the background once four-fifths of its
   * lifetime or its use budget is gone. See {@link DataKeyCache} for why this is
   * not merely an optimisation.
   */
  readonly refreshFraction?: number;
  /** Injected so a spec can move time without waiting for it. */
  readonly now?: () => number;
}

interface ActiveKey {
  readonly key: DataKey;
  uses: number;
  readonly expiresAt: number;
  readonly refreshAt: number;
  readonly maxUses: number;
  readonly refreshAfterUses: number;
}

interface UnwrappedEntry {
  readonly plaintext: Promise<Buffer>;
  readonly expiresAt: number;
}

/**
 * The materials cache: one active data key per encrypted column, and the
 * recently unwrapped keys needed to read rows back.
 *
 * Without it, envelope encryption costs a KMS round trip per value written and
 * per value read, which is a page of twenty orders turning into twenty-one
 * remote calls — the shape of problem `docs/dataloader.md` is about, with money
 * attached. With it, the steady state is no remote calls at all.
 *
 * Caching key material is a deliberate weakening and the limits are what bound
 * it, so they are two separate limits on purpose:
 *
 * - **Time** (`ttlMs`) bounds how long a compromise of this process's memory
 *   keeps paying, and how long after a KMS grant is revoked this process can
 *   still read rows. A cached key does not care that the grant is gone.
 * - **Uses** (`maxUses`) bounds how many values share one key, which is a
 *   cryptographic limit rather than an operational one: GCM's random 96-bit IVs
 *   have a birthday bound over the values encrypted under *one* key, and a
 *   repeated IV under the same key is the one GCM failure that costs more than
 *   a plaintext.
 *
 * Retirement is *proactive*, which is the non-obvious part. A key replaced only
 * once it has expired means the replacement — a real network call to KMS — lands
 * inside whichever request happened to arrive at that moment, and in this
 * codebase writes happen inside a database transaction. A remote call inside a
 * transaction holds a Postgres connection open for the length of somebody else's
 * network latency, which is the thing `PlaceOrderHandler` is careful not to do
 * anywhere else. So past `refreshFraction` of its budget the key is replaced in
 * the background and the caller is given the current one: the cost is that a
 * slightly older key encrypts a few more values, and the benefit is that no
 * ordinary request ever waits for KMS.
 */
export class DataKeyCache {
  private readonly logger = new Logger(DataKeyCache.name);
  private readonly now: () => number;
  private readonly refreshFraction: number;

  private readonly active = new Map<string, ActiveKey>();
  /** In-flight mints, so a cold start does not fire one KMS call per caller. */
  private readonly minting = new Map<string, Promise<ActiveKey>>();
  private readonly unwrapped = new Map<string, UnwrappedEntry>();

  constructor(
    private readonly source: DataKeySource,
    private readonly options: DataKeyCacheOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.refreshFraction = options.refreshFraction ?? 0.8;

    if (options.ttlMs <= 0 || options.maxUses <= 0 || options.maxDecryptEntries <= 0) {
      throw new Error(
        "DataKeyCache needs a positive ttlMs, maxUses and maxDecryptEntries: a zero budget " +
          "means a KMS call for every value, which is the cost this cache exists to remove.",
      );
    }
    if (this.refreshFraction <= 0 || this.refreshFraction >= 1) {
      throw new Error("DataKeyCache refreshFraction must be between 0 and 1, exclusive");
    }
  }

  /**
   * A data key to encrypt with, minting one if there is none to hand.
   *
   * Counts the use before returning, so a caller that goes on to fail still
   * spends the budget. That is the conservative direction: over-counting retires
   * a key early, and under-counting is what lets more values than `maxUses`
   * share one.
   */
  async encryptionKey(field: EncryptedField): Promise<DataKey> {
    const name = fieldName(field);
    const existing = this.active.get(name);

    if (existing && !this.isSpent(existing)) {
      existing.uses += 1;
      if (this.shouldRefresh(existing)) this.refreshInBackground(field, name);
      return existing.key;
    }

    const fresh = await this.mint(field, name);
    fresh.uses += 1;
    return fresh.key;
  }

  /**
   * Mints the key for `field` now, so the first write does not pay for it.
   *
   * Called at bootstrap. It does not make the *second* refresh free — that is
   * what `refreshFraction` is for — but it moves the one unavoidable cold call
   * out of a request and into startup.
   */
  async prepare(field: EncryptedField): Promise<void> {
    const name = fieldName(field);
    const existing = this.active.get(name);
    if (existing && !this.isSpent(existing)) return;
    await this.mint(field, name);
  }

  /**
   * The plaintext of a wrapped key, unwrapping it at most once per TTL.
   *
   * The map holds the *promise* rather than the resolved bytes, which is what
   * makes reading a page of rows one call instead of twenty: every row on a page
   * written in the same window carries the same wrapped key, and without this
   * they would all miss the cache within the same tick. A rejected unwrap is
   * evicted rather than remembered — a throttled call must be retryable, and a
   * blob that will never unwrap is cheap to refuse again.
   */
  unwrap(field: EncryptedField, wrapped: Buffer): Promise<Buffer> {
    const key = `${fieldName(field)}|${wrapped.toString("base64")}`;
    const now = this.now();

    const hit = this.unwrapped.get(key);
    if (hit && hit.expiresAt > now) return hit.plaintext;
    if (hit) this.unwrapped.delete(key);

    const plaintext = this.source.unwrap(field, wrapped).catch((cause: unknown) => {
      this.unwrapped.delete(key);
      throw cause;
    });

    this.unwrapped.set(key, { plaintext, expiresAt: now + this.options.ttlMs });
    this.evictOldestUnwrapped();
    return plaintext;
  }

  /**
   * Forgets every cached key.
   *
   * Used by the specs, and by nothing in production — there is no "log out of
   * KMS". The material is deliberately *not* zeroed on the way out, and that is
   * a considered omission rather than one to fix later: V8 copies and relocates
   * buffers as it collects them, so a `fill(0)` on the reference this map holds
   * says nothing about the copies the heap may still contain, and a call site
   * that is mid-`await` with the same buffer would have its key zeroed
   * underneath it. An assurance that cannot be kept is worse than none, and the
   * control that actually holds here is the one KMS provides: this process never
   * has the master key, and the data keys it does have expire.
   */
  clear(): void {
    this.active.clear();
    this.minting.clear();
    this.unwrapped.clear();
  }

  /** For the specs and for a future gauge: how much material is resident. */
  get sizes(): { active: number; unwrapped: number } {
    return { active: this.active.size, unwrapped: this.unwrapped.size };
  }

  private isSpent(entry: ActiveKey): boolean {
    return this.now() >= entry.expiresAt || entry.uses >= entry.maxUses;
  }

  private shouldRefresh(entry: ActiveKey): boolean {
    return this.now() >= entry.refreshAt || entry.uses >= entry.refreshAfterUses;
  }

  private mint(field: EncryptedField, name: string): Promise<ActiveKey> {
    const inFlight = this.minting.get(name);
    if (inFlight) return inFlight;

    const promise = this.source
      .mint(field)
      .then((key) => {
        const entry = this.newEntry(key);
        this.active.set(name, entry);
        return entry;
      })
      .finally(() => {
        this.minting.delete(name);
      });

    this.minting.set(name, promise);
    return promise;
  }

  private newEntry(key: DataKey): ActiveKey {
    const { ttlMs, maxUses } = this.options;
    return {
      key,
      uses: 0,
      expiresAt: this.now() + ttlMs,
      refreshAt: this.now() + Math.floor(ttlMs * this.refreshFraction),
      maxUses,
      // At least one use short of the limit, so a key with a budget of one still
      // has something to refresh *before*.
      refreshAfterUses: Math.max(1, Math.floor(maxUses * this.refreshFraction)),
    };
  }

  /**
   * Replaces the active key without making anybody wait for it.
   *
   * Failures are logged and swallowed: the current key is still valid, so a KMS
   * hiccup during a refresh must not fail the request that triggered it. If KMS
   * is still unreachable when the key finally expires, the caller that finds it
   * spent gets the error then — which is the right moment for it, because by
   * then there is genuinely nothing to encrypt with.
   */
  private refreshInBackground(field: EncryptedField, name: string): void {
    if (this.minting.has(name)) return;

    void this.mint(field, name).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(
        `Could not refresh the data key for ${name} ahead of its expiry: ${message}. The ` +
          `current key is still in use until it expires.`,
      );
    });
  }

  /**
   * Bounds the unwrap cache by count, oldest first.
   *
   * `Map` iterates in insertion order, so the first key is the least recently
   * *inserted*. Not least recently used — an LRU would need a touch on every
   * read and buys little here, because the access pattern is "the handful of
   * keys the recent rows were written under" and those are the recent insertions
   * anyway.
   */
  private evictOldestUnwrapped(): void {
    while (this.unwrapped.size > this.options.maxDecryptEntries) {
      const oldest = this.unwrapped.keys().next();
      if (oldest.done) return;
      this.unwrapped.delete(oldest.value);
    }
  }
}
