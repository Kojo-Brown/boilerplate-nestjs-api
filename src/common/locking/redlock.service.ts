import { randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { SystemLockClock } from "./ports";
import type {
  DistributedLock,
  LockAcquireOptions,
  LockClock,
  LockHandle,
  LockLogger,
  LockRandom,
} from "./ports";

/**
 * Claims the lock on one node and, having claimed it, draws a fencing token.
 *
 * The two steps are one script because they must not be separable: a token
 * drawn without the lock would be handed to a caller that does not hold it, and
 * a lock taken without a token would leave the holder unable to fence its own
 * writes. `-1` means the key was already held — Lua has no way to return a
 * status reply and a number from the same branch, and `0` is a value `INCR`
 * could legitimately produce after a `DECR` nobody in this codebase issues.
 *
 * `INCR` on a counter *shared by every key* rather than one per lock key: a
 * token only has to be strictly greater than every token issued before it, and
 * a single counter gives that for free while keeping the node's key count at
 * one. Per-key counters would have to either live forever or expire — and an
 * expiring counter restarts the sequence at 1, which a resource that has
 * already accepted token 5,000 will refuse forever.
 */
const ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  return redis.call('INCR', KEYS[2])
end
return -1
`;

/**
 * Pushes a node's counter up to a token that has already been issued.
 *
 * This is the step that makes the tokens monotonic rather than merely large.
 * A node that refused an acquisition never ran `INCR` for it, so its counter
 * lags; without this, an acquirer whose quorum happens to be those laggards
 * could draw a token *below* one already in use. Publishing the token to a
 * majority closes that: every later quorum shares at least one node with this
 * one, and that node's `INCR` therefore returns something strictly greater.
 *
 * Never lowers a counter, so it is safe to run out of order or twice, which
 * matters because it is sent to every node including ones whose acquisition
 * failed.
 */
const BUMP_FENCE = `
local raw = redis.call('GET', KEYS[1])
local current = tonumber(raw)
if current == nil then current = 0 end
local token = tonumber(ARGV[1])
if current < token then
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
`;

/**
 * Deletes the key only if it still carries this holder's value.
 *
 * A bare `DEL` is the classic distributed-locking bug: a holder whose lease
 * expired mid-operation would delete the lock its successor is holding, and
 * then a third caller would take it while two are running.
 */
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** The same check, restarting the lease instead of dropping it. */
const EXTEND = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * `defineCommand` attaches each script as a method that sends `EVALSHA` and
 * falls back to `EVAL` on a cache miss, so a script body travels once per
 * connection rather than once per acquisition. The methods are added at
 * runtime, so their shape has to be declared.
 */
interface ScriptedRedis extends Redis {
  redlockAcquire(lockKey: string, fenceKey: string, value: string, ttlMs: string): Promise<number>;
  redlockBumpFence(fenceKey: string, token: string): Promise<number>;
  redlockRelease(lockKey: string, value: string): Promise<number>;
  redlockExtend(lockKey: string, value: string, ttlMs: string): Promise<number>;
}

export interface RedlockOptions {
  readonly clock?: LockClock;
  /** Uniform over `[0, 1)`. Only used for retry jitter. */
  readonly random?: LockRandom;
  readonly logger?: LockLogger;
  /**
   * Fraction of the TTL written off as clock drift between this process and the
   * Redis nodes, added to {@link driftConstantMs}. Antirez's reference
   * implementation uses 0.01, and the reason to keep it is that the alternative
   * — assuming the clocks agree — makes the last few milliseconds of every
   * lease a period in which two holders both believe they are inside it.
   */
  readonly driftFactor?: number;
  /** Fixed drift allowance, covering the round trip itself. */
  readonly driftConstantMs?: number;
  /** Base delay between attempts when the caller is willing to wait. */
  readonly retryDelayMs?: number;
  /**
   * Per-node deadline for a single command, in milliseconds.
   *
   * An unreachable node must not be able to spend the whole TTL: an acquisition
   * that takes longer than its own lease is worthless, and the algorithm's
   * safety argument assumes the round trip is small relative to it. Enforced
   * with a real `setTimeout` rather than through {@link LockClock}, because it
   * is a watchdog on a socket rather than a logical clock — a test with a fake
   * clock still wants a real timer here.
   */
  readonly nodeTimeoutMs?: number;
  /** Namespace for lock keys, keeping them clear of the cache's and BullMQ's. */
  readonly keyPrefix?: string;
  /** The one counter every fencing token is drawn from. */
  readonly fenceKey?: string;
}

const DEFAULTS = {
  driftFactor: 0.01,
  driftConstantMs: 2,
  retryDelayMs: 100,
  nodeTimeoutMs: 500,
  keyPrefix: "redlock:lock:",
  fenceKey: "redlock:fence",
} as const;

/** Outcome of one script on one node: a value, or the reason there is none. */
interface NodeResult {
  readonly index: number;
  readonly value?: number;
  readonly error?: unknown;
}

export class RedlockAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedlockAcquisitionError";
  }
}

/**
 * Redlock: mutual exclusion across replicas, over N independent Redis masters.
 *
 * "Independent" is the whole design. Locking against a single primary with
 * replicas is unsafe in a way that looks fine right up until a failover:
 * replication is asynchronous, so a lock acknowledged by the primary and not
 * yet replicated is simply absent from the replica that gets promoted, and the
 * next caller takes a lock somebody already holds. Redlock replaces that with a
 * majority of nodes that never replicate to each other, so losing a minority
 * loses no acknowledged lock.
 *
 * ## What it does and does not promise
 *
 * It is an *efficiency* primitive with a safety net, not a consensus protocol.
 * Martin Kleppmann's critique of it is correct on the point that matters here:
 * a lease cannot make a stopped process notice it has been stopped, so a holder
 * paused past its TTL — a long GC, a suspended VM, a network black hole — will
 * resume believing it still holds the lock while its successor is running.
 *
 * This implementation therefore does not pretend the lease is the guarantee.
 * Every acquisition carries a strictly increasing {@link LockHandle.fencingToken},
 * and the resource being protected is expected to reject writes carrying a
 * token below the highest it has accepted. Where the resource cannot do that —
 * a filesystem, most third-party APIs — the lock is a way to *reduce* duplicate
 * work, and the operation underneath it still has to be idempotent.
 * `docs/distributed-locking.md` spells out the failure modes and what each one
 * costs.
 *
 * ## Connection handling
 *
 * Deliberately not this class's problem beyond closing the clients at
 * shutdown: retries, TLS and topology are configured where the clients are
 * constructed, in `locking.module.ts`.
 */
export class RedlockService implements DistributedLock, OnModuleDestroy {
  private readonly nodes: ScriptedRedis[];
  private readonly clock: LockClock;
  private readonly random: LockRandom;
  private readonly logger: LockLogger;
  private readonly options: Required<Omit<RedlockOptions, "clock" | "random" | "logger">>;

  /** A majority. Two of three, three of five: the smallest set that cannot overlap with its own complement. */
  readonly quorum: number;

  constructor(nodes: readonly Redis[], options: RedlockOptions = {}) {
    if (nodes.length === 0) {
      throw new RedlockAcquisitionError("RedlockService needs at least one Redis node.");
    }

    this.nodes = nodes.map((node) => {
      node.defineCommand("redlockAcquire", { numberOfKeys: 2, lua: ACQUIRE });
      node.defineCommand("redlockBumpFence", { numberOfKeys: 1, lua: BUMP_FENCE });
      node.defineCommand("redlockRelease", { numberOfKeys: 1, lua: RELEASE });
      node.defineCommand("redlockExtend", { numberOfKeys: 1, lua: EXTEND });
      return node as ScriptedRedis;
    });

    this.quorum = Math.floor(nodes.length / 2) + 1;
    this.clock = options.clock ?? new SystemLockClock();
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? new Logger(RedlockService.name);
    this.options = {
      driftFactor: options.driftFactor ?? DEFAULTS.driftFactor,
      driftConstantMs: options.driftConstantMs ?? DEFAULTS.driftConstantMs,
      retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
      nodeTimeoutMs: options.nodeTimeoutMs ?? DEFAULTS.nodeTimeoutMs,
      keyPrefix: options.keyPrefix ?? DEFAULTS.keyPrefix,
      fenceKey: options.fenceKey ?? DEFAULTS.fenceKey,
    };
  }

  async acquire(key: string, options: LockAcquireOptions): Promise<LockHandle | null> {
    const ttlMs = assertPositiveInteger("ttlMs", options.ttlMs);
    const waitMs = options.waitMs === undefined ? 0 : assertNonNegative("waitMs", options.waitMs);
    const retryDelayMs =
      options.retryDelayMs === undefined
        ? this.options.retryDelayMs
        : assertNonNegative("retryDelayMs", options.retryDelayMs);

    const deadline = this.clock.now() + waitMs;

    for (let attempt = 1; ; attempt += 1) {
      const handle = await this.attempt(key, ttlMs, attempt);
      if (handle) return handle;

      const remaining = deadline - this.clock.now();
      if (remaining <= 0) return null;

      // Full jitter, for the same reason `@Retry()` uses it: every caller that
      // lost this round would otherwise wake at the same moment and collide
      // again. Capped at what is left of the budget so waiting never overruns
      // the caller's own deadline.
      await this.clock.sleep(Math.min(remaining, Math.round(retryDelayMs * this.random())));
    }
  }

  /**
   * Closes every client so `SIGTERM` is not held open by a live socket.
   *
   * `disconnect()` follows the `QUIT` unconditionally, because a node that is
   * *down* at shutdown never answers the `QUIT` and ioredis keeps retrying the
   * connection on a timer — which would make one unreachable node the reason
   * the process refuses to exit. It is idempotent, so it costs nothing on the
   * nodes that answered.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      this.nodes.map(async (node) => {
        try {
          await node.quit();
        } finally {
          node.disconnect();
        }
      }),
    );
  }

  /**
   * One pass over every node: claim, then publish the token that was drawn.
   *
   * Both phases are checked against the remaining validity, not just the vote
   * count. A quorum that took longer than the TTL to assemble is a lock that
   * has already expired — counting the votes and returning it anyway is how an
   * overloaded cluster hands the same key to two callers.
   */
  private async attempt(key: string, ttlMs: number, attempt: number): Promise<LockHandle | null> {
    const lockKey = this.options.keyPrefix + key;
    // 16 bytes from the CSPRNG. The value is what makes release and extend
    // safe, so a guessable or colliding one would let an unrelated holder
    // release this lock.
    const value = randomBytes(16).toString("hex");
    const drift = Math.round(ttlMs * this.options.driftFactor) + this.options.driftConstantMs;
    const start = this.clock.now();
    const validityFrom = (): number => ttlMs - (this.clock.now() - start) - drift;

    const votes = await this.onEveryNode((node) =>
      node.redlockAcquire(lockKey, this.options.fenceKey, value, String(ttlMs)),
    );
    const claimed = votes.filter((vote) => vote.value !== undefined && vote.value > 0);

    if (claimed.length < this.quorum || validityFrom() <= 0) {
      await this.releaseEverywhere(lockKey, value);
      this.logger.debug(
        describe("acquire-failed", key, {
          attempt,
          claimed: claimed.length,
          quorum: this.quorum,
          nodes: this.nodes.length,
          validityMs: Math.round(validityFrom()),
          errors: votes.filter((vote) => vote.error !== undefined).map((vote) => vote.index),
        }),
      );
      return null;
    }

    const token = Math.max(...claimed.map((vote) => vote.value as number));
    if (!Number.isSafeInteger(token)) {
      // Unreachable short of ~9×10^15 acquisitions, but a token that has lost
      // precision compares equal to its neighbours, which silently disables
      // fencing rather than breaking anything visibly.
      await this.releaseEverywhere(lockKey, value);
      throw new RedlockAcquisitionError(
        `Fencing counter ${this.options.fenceKey} exceeded the safe integer range (${token}).`,
      );
    }

    const bumps = await this.onEveryNode((node) =>
      node.redlockBumpFence(this.options.fenceKey, String(token)),
    );
    const published = bumps.filter((bump) => bump.value === 1);
    const validity = validityFrom();

    if (published.length < this.quorum || validity <= 0) {
      // The lock may well be held on a quorum, but its token cannot be trusted
      // to be above every token already issued — so it is not a lock this
      // implementation is willing to hand out.
      await this.releaseEverywhere(lockKey, value);
      this.logger.warn(
        describe("fence-publish-failed", key, {
          attempt,
          published: published.length,
          quorum: this.quorum,
          validityMs: Math.round(validity),
        }),
      );
      return null;
    }

    this.logger.debug(
      describe("acquired", key, {
        attempt,
        token,
        claimed: claimed.length,
        validityMs: Math.round(validity),
      }),
    );

    return new RedlockHandle(this, key, lockKey, value, token, this.clock.now() + validity);
  }

  /** @internal — used by {@link RedlockHandle}. */
  async extendEverywhere(lockKey: string, value: string, ttlMs: number): Promise<number | null> {
    const drift = Math.round(ttlMs * this.options.driftFactor) + this.options.driftConstantMs;
    const start = this.clock.now();
    const results = await this.onEveryNode((node) =>
      node.redlockExtend(lockKey, value, String(ttlMs)),
    );
    const extended = results.filter((result) => result.value === 1);
    const validity = ttlMs - (this.clock.now() - start) - drift;

    if (extended.length < this.quorum || validity <= 0) {
      // Losing the quorum means this handle is not the holder any more, and
      // whatever it still occupies on a minority of nodes is only in the way.
      await this.releaseEverywhere(lockKey, value);
      return null;
    }
    return validity;
  }

  /** @internal — used by {@link RedlockHandle}. Resolves the number of nodes that still held `value`. */
  async releaseEverywhere(lockKey: string, value: string): Promise<number> {
    const results = await this.onEveryNode((node) => node.redlockRelease(lockKey, value));
    return results.filter((result) => result.value === 1).length;
  }

  /** @internal — used by {@link RedlockHandle}. */
  get now(): number {
    return this.clock.now();
  }

  /**
   * Runs one command against every node, waiting for all of them.
   *
   * A rejection is a result, not an exception: an unreachable node is the
   * ordinary case this algorithm exists to survive, and one thrown error must
   * not discard the votes that did come back. The per-node timeout bounds how
   * long a node that neither answers nor fails can hold the whole attempt.
   */
  private async onEveryNode(
    command: (node: ScriptedRedis) => Promise<number>,
  ): Promise<NodeResult[]> {
    return await Promise.all(
      this.nodes.map(async (node, index): Promise<NodeResult> => {
        try {
          return { index, value: await withTimeout(command(node), this.options.nodeTimeoutMs) };
        } catch (error) {
          return { index, error };
        }
      }),
    );
  }
}

/**
 * A lock held on a quorum, as its holder sees it.
 *
 * Not exported: a handle is only ever obtained from {@link RedlockService.acquire},
 * because constructing one means asserting the quorum agreed, which nothing
 * outside the service is in a position to know.
 */
class RedlockHandle implements LockHandle {
  private expiry: number;
  private live = true;

  constructor(
    private readonly service: RedlockService,
    readonly key: string,
    private readonly lockKey: string,
    private readonly value: string,
    readonly fencingToken: number,
    validUntil: number,
  ) {
    this.expiry = validUntil;
  }

  get validUntil(): number {
    return this.expiry;
  }

  remainingMs(): number {
    return Math.max(0, this.expiry - this.service.now);
  }

  async extend(ttlMs: number): Promise<boolean> {
    assertPositiveInteger("ttlMs", ttlMs);
    if (!this.live) return false;

    const validity = await this.service.extendEverywhere(this.lockKey, this.value, ttlMs);
    if (validity === null) {
      this.live = false;
      this.expiry = this.service.now;
      return false;
    }
    this.expiry = this.service.now + validity;
    return true;
  }

  async release(): Promise<boolean> {
    if (!this.live) return false;
    this.live = false;

    const released = await this.service.releaseEverywhere(this.lockKey, this.value);
    this.expiry = this.service.now;
    // A quorum is the same bar acquisition had to clear: below it, this handle
    // was no longer the holder by the time it let go.
    return released >= this.service.quorum;
  }
}

/**
 * Rejects once `ms` has passed, without cancelling the underlying command.
 *
 * There is nothing to cancel: ioredis has already written the command to the
 * socket, and the node may well apply it. That is precisely why a timed-out
 * acquisition is released rather than assumed to have failed — the key may be
 * held on a node whose answer never arrived.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis node did not answer within ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RedlockAcquisitionError(
      `${name} must be a positive integer number of milliseconds, got ${String(value)}.`,
    );
  }
  return value;
}

function assertNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RedlockAcquisitionError(
      `${name} must be a non-negative number, got ${String(value)}.`,
    );
  }
  return value;
}

function describe(event: string, key: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ lock: "redlock", event, key, ...fields });
}
