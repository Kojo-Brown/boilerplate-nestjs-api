import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import type {
  IdempotencyRecord,
  IdempotencyStore,
  InFlightRecord,
  RecordedResponse,
} from "../ports";

/**
 * Keeps these keys apart from the cache's and BullMQ's in a shared Redis.
 *
 * Applied inside the store rather than by the caller so nothing outside has to
 * know the layout, and `get()` stays symmetric with `reserve()`.
 */
const KEY_PREFIX = "idempotency:";

/**
 * `SET NX` can fail and then find nothing to read back — the holder's TTL may
 * elapse in that window. Two extra attempts is enough for a race that needs a
 * millisecond-scale expiry to happen at all; looping without a bound would turn
 * a pathologically short TTL into a hot loop.
 */
const RESERVE_ATTEMPTS = 3;

/**
 * Marks the record completed, but only if the caller still holds the lease.
 *
 * Read-then-write from the client would be two round trips with a gap in the
 * middle, and a retry that reserved the key inside that gap would have its
 * reservation overwritten by the loser's `SET`. Redis runs a script to
 * completion without interleaving, which is what makes the check and the write
 * one indivisible step.
 *
 * The fingerprint is carried over from the stored record rather than passed in,
 * so the value written is always the one the reservation was made with.
 */
const COMPLETE_IF_LEASED = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if not ok or record['lease'] ~= ARGV[1] then return 0 end
record['state'] = 'completed'
record['response'] = cjson.decode(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[3])
return 1
`;

/** The same check, deleting the reservation instead of resolving it. */
const RELEASE_IF_LEASED = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if not ok or record['lease'] ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * `defineCommand` attaches a script as a method that sends `EVALSHA` and falls
 * back to `EVAL` on a script-cache miss, so the body travels once per
 * connection rather than once per request. The methods are added at runtime, so
 * their shape has to be declared.
 */
interface ScriptedRedis extends Redis {
  completeIfLeased(key: string, lease: string, response: string, ttlMs: string): Promise<number>;
  releaseIfLeased(key: string, lease: string): Promise<number>;
}

/** Raised when the store cannot decide whether a key is free. */
export class IdempotencyStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyStoreUnavailableError";
  }
}

/**
 * The dedupe store as it runs in production: one Redis, every replica pointed
 * at it, `SET NX` deciding which request owns a key.
 *
 * Connection handling is deliberately not this class's problem — it is given a
 * client and closes it at shutdown. Retries, TLS and cluster topology are
 * configured where the client is constructed, in `idempotency.module.ts`.
 */
@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore, OnModuleDestroy {
  private readonly logger = new Logger(RedisIdempotencyStore.name);

  private readonly redis: ScriptedRedis;

  constructor(redis: Redis) {
    redis.defineCommand("completeIfLeased", { numberOfKeys: 1, lua: COMPLETE_IF_LEASED });
    redis.defineCommand("releaseIfLeased", { numberOfKeys: 1, lua: RELEASE_IF_LEASED });
    this.redis = redis as ScriptedRedis;
  }

  async reserve(
    key: string,
    record: InFlightRecord,
    ttlMs: number,
  ): Promise<IdempotencyRecord | null> {
    const namespaced = KEY_PREFIX + key;
    const ttl = normaliseTtl(ttlMs);

    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
      const claimed = await this.redis.set(namespaced, JSON.stringify(record), "PX", ttl, "NX");
      if (claimed === "OK") return null;

      const entry = await this.readEntry(namespaced);
      if (entry.record) return entry.record;

      if (entry.raw !== null) {
        // Something unreadable is sitting on the key and `NX` will keep
        // refusing for as long as it stays there — which, if it was written
        // without a TTL, is forever. Since it cannot be honoured as a record,
        // claim the key outright rather than spinning until the attempt limit.
        await this.redis.set(namespaced, JSON.stringify(record), "PX", ttl);
        return null;
      }
      // The holder's key expired between the two calls, so nobody owns it now.
      // Go round again and try to claim it.
    }

    // Only reachable when the key keeps expiring mid-reservation, which means
    // the configured TTL is shorter than a round trip. Refusing is safer than
    // executing: nothing has run yet, so the caller can answer 503 and the
    // client can retry against a fixed deployment.
    throw new IdempotencyStoreUnavailableError(
      `Could not reserve an idempotency key after ${RESERVE_ATTEMPTS} attempts — ` +
        `the configured TTL (${ttlMs}ms) is too short to outlive a round trip`,
    );
  }

  async complete(
    key: string,
    lease: string,
    response: RecordedResponse,
    ttlMs: number,
  ): Promise<boolean> {
    const updated = await this.redis.completeIfLeased(
      KEY_PREFIX + key,
      lease,
      JSON.stringify(response),
      String(normaliseTtl(ttlMs)),
    );
    return updated === 1;
  }

  async release(key: string, lease: string): Promise<boolean> {
    return (await this.redis.releaseIfLeased(KEY_PREFIX + key, lease)) === 1;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    return (await this.readEntry(KEY_PREFIX + key)).record;
  }

  /** Closes the connection so `SIGTERM` is not held open by a live socket. */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Reads a key, keeping "nothing is there" and "something unreadable is there"
   * apart — `reserve` has to treat them differently, and both collapse to a
   * `null` record.
   */
  private async readEntry(
    namespaced: string,
  ): Promise<{ raw: string | null; record: IdempotencyRecord | null }> {
    const raw = await this.redis.get(namespaced);
    if (raw === null) return { raw: null, record: null };

    const record = parseRecord(raw);
    if (!record) {
      // A value that is not a record cannot have been written by this version.
      // Treating it as absent lets the request proceed and the key be rewritten
      // correctly, which is strictly better than failing every retry until the
      // TTL clears whatever is sitting there.
      this.logger.warn(`Discarding unreadable idempotency record at ${namespaced}`);
    }

    return { raw, record };
  }
}

/** `PX` rejects zero and non-integers, and a negative TTL would delete the key. */
function normaliseTtl(ttlMs: number): number {
  return Math.max(1, Math.trunc(ttlMs));
}

/**
 * Exported for the store's own tests, which write malformed values directly.
 * Nothing else should need it.
 */
export function parseRecord(raw: string): IdempotencyRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<IdempotencyRecord>;

  if (typeof candidate.fingerprint !== "string" || typeof candidate.lease !== "string") {
    return null;
  }

  if (candidate.state === "in-flight") {
    return { state: "in-flight", fingerprint: candidate.fingerprint, lease: candidate.lease };
  }

  if (candidate.state === "completed" && isRecordedResponse(candidate.response)) {
    return {
      state: "completed",
      fingerprint: candidate.fingerprint,
      lease: candidate.lease,
      response: candidate.response,
    };
  }

  return null;
}

function isRecordedResponse(value: unknown): value is RecordedResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RecordedResponse>;

  return (
    typeof candidate.status === "number" &&
    (candidate.contentType === null || typeof candidate.contentType === "string") &&
    (candidate.body === null || typeof candidate.body === "string")
  );
}
