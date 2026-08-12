import { Injectable } from "@nestjs/common";
import type {
  IdempotencyRecord,
  IdempotencyStore,
  InFlightRecord,
  RecordedResponse,
} from "../ports";

interface Entry {
  readonly record: IdempotencyRecord;
  /** `Date.now()` past which the entry no longer exists. */
  readonly expiresAt: number;
}

/**
 * A single-process dedupe store.
 *
 * Correct for tests, `pnpm dev`, and any deployment that is genuinely one
 * process — and wrong for every other one, because two replicas do not share a
 * `Map`: the retry that a load balancer sends to the second replica finds no
 * record and executes the operation a second time. That is the failure the
 * whole module exists to prevent, and it is silent, so `env.schema.ts` refuses
 * this store in production rather than warning about it.
 *
 * Expiry is swept lazily on read instead of with a `setTimeout` per key. Timers
 * would keep the event loop alive and make a graceful shutdown wait out the
 * longest TTL — 24 hours, by default.
 */
@Injectable()
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  /**
   * Injected so tests can advance time without sleeping through a TTL. The
   * default is the real clock; nothing in `src` passes anything else.
   */
  constructor(private readonly now: () => number = Date.now) {}

  async reserve(
    key: string,
    record: InFlightRecord,
    ttlMs: number,
  ): Promise<IdempotencyRecord | null> {
    const existing = this.read(key);
    if (existing) return existing;

    this.entries.set(key, { record, expiresAt: this.now() + ttlMs });
    return null;
  }

  async complete(
    key: string,
    lease: string,
    response: RecordedResponse,
    ttlMs: number,
  ): Promise<boolean> {
    const existing = this.read(key);
    if (!existing || existing.lease !== lease) return false;

    this.entries.set(key, {
      record: { state: "completed", fingerprint: existing.fingerprint, lease, response },
      expiresAt: this.now() + ttlMs,
    });
    return true;
  }

  async release(key: string, lease: string): Promise<boolean> {
    const existing = this.read(key);
    if (!existing || existing.lease !== lease) return false;

    this.entries.delete(key);
    return true;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.read(key);
  }

  /** Empties the store. For tests; nothing in `src` calls it. */
  clear(): void {
    this.entries.clear();
  }

  private read(key: string): IdempotencyRecord | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.record;
  }
}
