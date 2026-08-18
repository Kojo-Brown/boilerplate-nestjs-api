import type { Redis } from "ioredis";
import { FakeLockClock } from "@/test-utils/fake-lock-clock";
import { FakeRedisNode } from "@/test-utils/fake-redis-node";
import { RedlockAcquisitionError, RedlockService } from "./redlock.service";
import type { LockLogger } from "./ports";

/**
 * What the shared contract cannot reach: the states a quorum gets into when
 * nodes disagree.
 *
 * The contract suite runs against real `redis-server` processes and proves the
 * semantics. It cannot stage a node that has gone quiet mid-command, counters
 * that have drifted apart, or a round trip that outlasts the lease — and those
 * are precisely the conditions the algorithm exists to handle, so they are
 * driven here against fakes instead.
 */
describe("RedlockService", () => {
  const KEY = "orders:o-1";
  const LOCK_KEY = `redlock:lock:${KEY}`;
  const TTL_MS = 5_000;

  let clock: FakeLockClock;
  let nodes: FakeRedisNode[];
  let logged: string[];
  let logger: LockLogger;

  function build(count = 3, options: Record<string, unknown> = {}): RedlockService {
    nodes = Array.from({ length: count }, () => new FakeRedisNode(clock));
    return new RedlockService(
      nodes.map((node) => node.asRedis()),
      { clock, random: () => 0.5, logger, ...options },
    );
  }

  beforeEach(() => {
    clock = new FakeLockClock();
    logged = [];
    logger = { debug: (message) => logged.push(message), warn: (message) => logged.push(message) };
  });

  it("refuses to be constructed with no nodes to vote", () => {
    expect(() => new RedlockService([])).toThrow(RedlockAcquisitionError);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [5, 3],
  ])("needs %i of %i nodes for a majority", (count, expected) => {
    expect(build(count).quorum).toBe(expected);
  });

  describe("acquire", () => {
    it("claims the key on every node and issues the highest token drawn", async () => {
      const redlock = build(3);

      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(held?.fencingToken).toBe(1);
      expect(nodes.every((node) => node.isHeld(LOCK_KEY))).toBe(true);
      expect(held?.remainingMs()).toBeGreaterThan(0);
    });

    it("still acquires with one node down, which is the point of a quorum", async () => {
      const redlock = build(3);
      nodes[2]!.down = true;

      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(held).not.toBeNull();
      expect(nodes[2]!.isHeld(LOCK_KEY)).toBe(false);
    });

    it("gives up, and gives back, once a majority is unreachable", async () => {
      const redlock = build(3);
      nodes[1]!.down = true;
      nodes[2]!.down = true;

      expect(await redlock.acquire(KEY, { ttlMs: TTL_MS })).toBeNull();
      // The one node that did answer must not be left holding a key nobody
      // owns: that would block every later attempt for the whole TTL.
      expect(nodes[0]!.isHeld(LOCK_KEY)).toBe(false);
    });

    it("does not wait for a node that has gone quiet", async () => {
      // `down` rejects; this is the worse case — a connection that was accepted
      // and then answered nothing, which without a deadline would hold the
      // acquisition open for as long as the socket stays up.
      const redlock = build(3, { nodeTimeoutMs: 20 });
      nodes[2]!.silent = true;

      expect(await redlock.acquire(KEY, { ttlMs: TTL_MS })).not.toBeNull();
    });

    it("refuses a quorum that took longer to assemble than the lease lasts", async () => {
      const redlock = build(3);
      // 3 × 400ms of round trip against a 500ms lease: the votes are in, and
      // they are votes for a lock that has already expired.
      for (const node of nodes) node.latencyMs = 400;

      expect(await redlock.acquire(KEY, { ttlMs: 500 })).toBeNull();
      expect(nodes.some((node) => node.isHeld(LOCK_KEY))).toBe(false);
    });

    it("refuses a key already held, and leaves the holder's lease alone", async () => {
      const redlock = build(3);
      const first = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(await redlock.acquire(KEY, { ttlMs: TTL_MS })).toBeNull();
      expect(first?.remainingMs()).toBeGreaterThan(0);
    });

    it("retries a held key with jittered backoff until the budget runs out", async () => {
      const redlock = build(3);
      await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(
        await redlock.acquire(KEY, { ttlMs: TTL_MS, waitMs: 250, retryDelayMs: 100 }),
      ).toBeNull();
      // 0.5 of the base delay each time, and the last wait is trimmed to what
      // was left of the budget rather than overrunning the caller's deadline.
      expect(clock.sleeps).toEqual([50, 50, 50, 50, 50]);
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["fractional", 12.5],
    ])("refuses a %s ttlMs rather than locking for an unknown time", async (_why, ttlMs) => {
      await expect(build(3).acquire(KEY, { ttlMs })).rejects.toThrow(RedlockAcquisitionError);
    });
  });

  describe("fencing tokens", () => {
    it("publishes the issued token to every node", async () => {
      const redlock = build(3);
      nodes[0]!.fence = 10;

      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(held?.fencingToken).toBe(11);
      expect(nodes.map((node) => node.fence)).toEqual([11, 11, 11]);
    });

    it("keeps issuing higher tokens after the quorum changes membership", async () => {
      // The property the publish step exists for. Node 0 has seen far more
      // acquisitions than the others; without publishing, a later quorum made
      // of the two laggards would draw a token *below* one already in use, and
      // a resource fencing on it would accept a stale write.
      const redlock = build(3);
      nodes[0]!.fence = 10;
      const first = await redlock.acquire(KEY, { ttlMs: TTL_MS });
      await first?.release();

      nodes[0]!.down = true;
      const second = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(second?.fencingToken).toBeGreaterThan(first?.fencingToken as number);
    });

    it("gives the lock back when the token cannot be published to a majority", async () => {
      const redlock = build(3);
      nodes[1]!.refuseBump = true;
      nodes[2]!.refuseBump = true;

      expect(await redlock.acquire(KEY, { ttlMs: TTL_MS })).toBeNull();
      // The key may well have been claimed on every node — but a token that is
      // not known to be above every earlier one is not a token worth handing
      // out, so the lock goes back rather than being served unfenced.
      expect(nodes.some((node) => node.isHeld(LOCK_KEY))).toBe(false);
      expect(logged.join()).toContain("fence-publish-failed");
    });

    it("refuses a token that has outgrown exact integer arithmetic", async () => {
      const redlock = build(3);
      for (const node of nodes) node.fence = Number.MAX_SAFE_INTEGER;

      // Unreachable in practice, and silent if it were not: past 2^53 a token
      // compares equal to its neighbours, so fencing would stop working
      // without anything failing.
      await expect(redlock.acquire(KEY, { ttlMs: TTL_MS })).rejects.toThrow(/safe integer range/);
      expect(nodes.some((node) => node.isHeld(LOCK_KEY))).toBe(false);
    });
  });

  describe("extend", () => {
    it("restarts the lease and keeps the token", async () => {
      const redlock = build(3);
      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });
      const token = held?.fencingToken;
      clock.advance(4_000);

      expect(await held?.extend(TTL_MS)).toBe(true);
      expect(held?.remainingMs()).toBeGreaterThan(4_000);
      expect(held?.fencingToken).toBe(token);
    });

    it("reports the loss, and lets go, when a majority no longer holds it", async () => {
      const redlock = build(3);
      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });
      nodes[1]!.down = true;
      nodes[2]!.down = true;

      expect(await held?.extend(TTL_MS)).toBe(false);
      expect(held?.remainingMs()).toBe(0);
      // Whatever is still occupied on the minority is only in the way now.
      expect(nodes[0]!.isHeld(LOCK_KEY)).toBe(false);
    });

    it("stays refused once the handle has been lost", async () => {
      const redlock = build(3);
      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });
      nodes[1]!.down = true;
      nodes[2]!.down = true;
      await held?.extend(TTL_MS);
      nodes[1]!.down = false;
      nodes[2]!.down = false;

      // The nodes came back, but this handle stopped being the holder the
      // moment it could not prove it was one.
      expect(await held?.extend(TTL_MS)).toBe(false);
    });
  });

  describe("release", () => {
    it("frees the key on every node", async () => {
      const redlock = build(3);
      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(await held?.release()).toBe(true);
      expect(nodes.some((node) => node.isHeld(LOCK_KEY))).toBe(false);
    });

    it("reports that it was no longer the holder", async () => {
      const redlock = build(3);
      const held = await redlock.acquire(KEY, { ttlMs: TTL_MS });
      clock.advance(TTL_MS + 1);
      const successor = await redlock.acquire(KEY, { ttlMs: TTL_MS });

      expect(await held?.release()).toBe(false);
      expect(successor?.remainingMs()).toBeGreaterThan(0);
      expect(nodes.every((node) => node.isHeld(LOCK_KEY))).toBe(true);
    });
  });

  it("closes every client at shutdown, including one that never answers", async () => {
    const quit = jest.fn().mockRejectedValue(new Error("connection refused"));
    const disconnect = jest.fn();
    const node = { defineCommand: () => {}, quit, disconnect };

    const redlock = new RedlockService([node as unknown as Redis]);
    await redlock.onModuleDestroy();

    // `quit` never answers on a node that is down, and ioredis keeps retrying
    // the connection on a timer — so the disconnect is what actually lets the
    // process exit.
    expect(quit).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });
});
