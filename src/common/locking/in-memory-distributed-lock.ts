import { SystemLockClock } from "./ports";
import type {
  DistributedLock,
  LockAcquireOptions,
  LockClock,
  LockHandle,
  LockRandom,
} from "./ports";

interface Entry {
  /** Identifies the holder, so a late release cannot drop a successor's lock. */
  readonly value: string;
  readonly fencingToken: number;
  expiresAt: number;
}

/**
 * The lock as a `Map`: correct for exactly one process, and honest about it.
 *
 * It exists for the same reason `InMemoryIdempotencyStore` does — a clean clone
 * boots and its tests run with nothing installed — and it is refused in
 * production by `env.schema.ts` for a sharper version of the same reason. A
 * `Map` is not shared between replicas, so the moment a second one exists this
 * excludes nothing at all while continuing to report every acquisition as a
 * success. That is the worst failure shape a lock can have: silent, and only
 * under load.
 *
 * Within one process it is a real lock rather than a stub. Node's event loop
 * gives it the atomicity Redis gives Redlock — nothing interleaves between the
 * read and the write below — expiry is enforced by the clock rather than by a
 * timer that a paused process would not fire, and the fencing tokens are drawn
 * from a counter that behaves exactly like the quorum-backed one. Handing the
 * contract suite something weaker would mean the suite proves nothing about the
 * implementation the tests actually run against.
 */
export class InMemoryDistributedLock implements DistributedLock {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: LockClock;
  private readonly random: LockRandom;
  private counter = 0;

  constructor(options: { clock?: LockClock; random?: LockRandom } = {}) {
    this.clock = options.clock ?? new SystemLockClock();
    this.random = options.random ?? Math.random;
  }

  async acquire(key: string, options: LockAcquireOptions): Promise<LockHandle | null> {
    const ttlMs = options.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`ttlMs must be a positive integer number of milliseconds, got ${ttlMs}`);
    }
    const deadline = this.clock.now() + (options.waitMs ?? 0);
    const retryDelayMs = options.retryDelayMs ?? 100;

    for (;;) {
      const handle = this.claim(key, ttlMs);
      if (handle) return handle;

      const remaining = deadline - this.clock.now();
      if (remaining <= 0) return null;
      await this.clock.sleep(Math.min(remaining, Math.round(retryDelayMs * this.random())));
    }
  }

  /** Drops every lock. For tests, which need to start from empty. */
  clear(): void {
    this.entries.clear();
  }

  private claim(key: string, ttlMs: number): LockHandle | null {
    const now = this.clock.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) return null;

    this.counter += 1;
    const entry: Entry = {
      value: `${this.counter}:${Math.trunc(this.random() * 1e9)}`,
      fencingToken: this.counter,
      expiresAt: now + ttlMs,
    };
    this.entries.set(key, entry);

    return {
      key,
      fencingToken: entry.fencingToken,
      get validUntil() {
        return entry.expiresAt;
      },
      remainingMs: () => Math.max(0, entry.expiresAt - this.clock.now()),
      extend: async (extendMs: number) => {
        if (!this.holds(key, entry)) return false;
        entry.expiresAt = this.clock.now() + extendMs;
        return true;
      },
      release: async () => {
        if (!this.holds(key, entry)) return false;
        this.entries.delete(key);
        return true;
      },
    };
  }

  /**
   * Whether `entry` is still the live holder of `key`.
   *
   * Identity is not enough: an expired entry that nobody has replaced is still
   * the one in the map, and treating that as held would let a holder extend a
   * lease that had already lapsed — the case the Redis implementation cannot
   * get wrong because the key is simply gone.
   */
  private holds(key: string, entry: Entry): boolean {
    const current = this.entries.get(key);
    return current === entry && entry.expiresAt > this.clock.now();
  }
}
