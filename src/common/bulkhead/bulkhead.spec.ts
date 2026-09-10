import { Bulkhead, BulkheadRejectedError } from "./bulkhead";
import type { BulkheadPolicy } from "./bulkhead";

const POLICY: BulkheadPolicy = { maxConcurrent: 2, maxQueued: 2, maxQueueWaitMs: 50 };

function bulkhead(overrides: Partial<BulkheadPolicy> = {}): Bulkhead {
  return new Bulkhead("stripe", { ...POLICY, ...overrides });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A promise this test settles by hand.
 *
 * Concurrency is what is under test, so nothing here may finish on its own: a
 * held permit is a `work` function that has not been resolved yet, and the cap
 * is asserted while it is held.
 */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-scheduled microtask run, so pending state is settled state. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`Expected a rejection, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
}

describe("Bulkhead", () => {
  describe("the concurrency cap", () => {
    it("admits calls up to the cap without queueing any of them", async () => {
      const limiter = bulkhead();
      const work = [deferred(), deferred()];

      const running = work.map((held) => limiter.run(() => held.promise));
      await flush();

      expect(limiter.stats()).toMatchObject({ inFlight: 2, queued: 0 });

      work.forEach((held) => held.resolve());
      await Promise.all(running);
      expect(limiter.stats()).toMatchObject({ inFlight: 0, queued: 0 });
    });

    it("queues the call that arrives over the cap until a permit comes back", async () => {
      const limiter = bulkhead();
      const held = [deferred(), deferred()];
      const running = held.map((one) => limiter.run(() => one.promise));

      const third = deferred();
      let thirdStarted = false;
      const queued = limiter.run(() => {
        thirdStarted = true;
        return third.promise;
      });
      await flush();

      // The point of the pattern: the third call exists, and the dependency has
      // not been asked to do a third thing.
      expect(thirdStarted).toBe(false);
      expect(limiter.stats()).toMatchObject({ inFlight: 2, queued: 1 });

      held[0]?.resolve();
      await flush();

      expect(thirdStarted).toBe(true);
      expect(limiter.stats()).toMatchObject({ inFlight: 2, queued: 0 });

      held[1]?.resolve();
      third.resolve();
      await Promise.all([...running, queued]);
    });

    it("hands a returned permit to the caller that has waited longest", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 3 });
      const first = deferred();
      const running = limiter.run(() => first.promise);
      await flush();

      const order: string[] = [];
      const waiters = ["b", "c", "d"].map((name) =>
        limiter.run(async () => {
          order.push(name);
        }),
      );
      await flush();
      expect(limiter.stats()).toMatchObject({ inFlight: 1, queued: 3 });

      first.resolve();
      await Promise.all([running, ...waiters]);

      // FIFO rather than whoever the event loop happens to wake: a queue that
      // reorders under load is a queue where one unlucky caller waits out
      // everybody else's timeout.
      expect(order).toEqual(["b", "c", "d"]);
    });

    it("never lets the cap be overshot in the tick a permit changes hands", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 2 });
      const first = deferred();
      const running = limiter.run(() => first.promise);
      await flush();

      const second = deferred();
      const queued = limiter.run(() => second.promise);
      await flush();

      // The permit goes straight from the first caller to the queued one, so a
      // newcomer in the same tick finds nothing free and queues behind it.
      first.resolve();
      const third = deferred();
      const late = limiter.run(() => third.promise);
      await flush();

      expect(limiter.stats()).toMatchObject({ inFlight: 1, queued: 1 });

      second.resolve();
      await flush();
      third.resolve();
      await Promise.all([running, queued, late]);
    });
  });

  describe("rejections", () => {
    it("rejects immediately once the queue is full", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 1 });
      const held = deferred();
      const running = limiter.run(() => held.promise);
      const queued = limiter.run(() => held.promise);
      await flush();

      const error = await rejection(limiter.acquire());

      expect(error).toBeInstanceOf(BulkheadRejectedError);
      expect(error).toMatchObject({ bulkhead: "stripe", reason: "queue-full" });
      expect((error as Error).message).toContain("1 calls in flight and 1 waiting");
      expect(limiter.stats()).toMatchObject({ queueFullRejections: 1, queueTimeoutRejections: 0 });

      held.resolve();
      await Promise.all([running, queued]);
    });

    it("rejects a queued call that waited longer than the policy allows", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 2, maxQueueWaitMs: 20 });
      const held = deferred();
      const running = limiter.run(() => held.promise);
      await flush();

      const error = await rejection(limiter.acquire());

      expect(error).toMatchObject({ reason: "queue-timeout" });
      expect(limiter.stats()).toMatchObject({
        inFlight: 1,
        queued: 0,
        queueTimeoutRejections: 1,
      });

      held.resolve();
      await running;
    });

    it("lets a caller shorten its own wait, but not lengthen it", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 2, maxQueueWaitMs: 30 });
      const held = deferred();
      const running = limiter.run(() => held.promise);
      await flush();

      const started = Date.now();
      const error = await rejection(limiter.acquire(5));
      const shortened = Date.now() - started;

      expect(error).toMatchObject({ reason: "queue-timeout" });
      // The caller asked for 5ms and got roughly that, not the policy's 30ms.
      // Timers only guarantee a floor, so the assertion is that the policy's
      // ceiling did not win rather than an exact duration.
      expect(shortened).toBeLessThan(30);

      // A budget above the ceiling is clamped to it: the cap is the operator's,
      // not the caller's.
      const clamped = await rejection(limiter.acquire(10_000));
      expect(clamped).toMatchObject({ reason: "queue-timeout" });

      held.resolve();
      await running;
    });

    it("does not queue a caller with no budget left", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 5 });
      const held = deferred();
      const running = limiter.run(() => held.promise);
      await flush();

      const error = await rejection(limiter.acquire(0));

      // Queueing here would be a wait the caller has already said it cannot
      // afford — its own deadline is spent — so it is turned away rather than
      // parked for a permit it could not use.
      expect(error).toMatchObject({ reason: "queue-timeout", waitedMs: 0 });
      expect(limiter.stats()).toMatchObject({ queued: 0, queueTimeoutRejections: 1 });

      held.resolve();
      await running;
    });

    it("admits a caller with no budget left when a permit is already free", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 5 });

      const release = await limiter.acquire(0);

      expect(limiter.stats()).toMatchObject({ inFlight: 1, queueTimeoutRejections: 0 });
      release();
    });
  });

  describe("permits", () => {
    it("releases the permit when the work throws", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 1 });

      await expect(
        limiter.run(() => Promise.reject(new Error("upstream exploded"))),
      ).rejects.toThrow("upstream exploded");

      expect(limiter.stats()).toMatchObject({ inFlight: 0 });
    });

    it("ignores a second release rather than inventing a permit", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 1 });
      const release = await limiter.acquire();

      release();
      release();

      // Counting releases instead of tracking one would leave `inFlight` at -1,
      // and a bulkhead whose counter can go negative is a bulkhead with no cap.
      expect(limiter.stats()).toMatchObject({ inFlight: 0 });

      const held = deferred();
      const running = limiter.run(() => held.promise);
      await flush();
      expect(limiter.stats()).toMatchObject({ inFlight: 1, queued: 0 });

      const error = await rejection(limiter.acquire(0));
      expect(error).toMatchObject({ reason: "queue-timeout" });

      held.resolve();
      await running;
    });
  });

  describe("stats", () => {
    it("reports the policy alongside the live counts", () => {
      const limiter = bulkhead({ maxConcurrent: 4, maxQueued: 7 });

      expect(limiter.stats()).toEqual({
        name: "stripe",
        inFlight: 0,
        queued: 0,
        maxConcurrent: 4,
        maxQueued: 7,
        queueFullRejections: 0,
        queueTimeoutRejections: 0,
      });
    });
  });

  describe("policy validation", () => {
    it.each([
      ["a cap of zero admits nothing, ever", { maxConcurrent: 0 }],
      ["a fractional cap is not a cap anybody meant", { maxConcurrent: 1.5 }],
      ["a negative queue is not a queue", { maxQueued: -1 }],
    ])("refuses to be built when %s", (_reason, overrides) => {
      expect(() => bulkhead(overrides)).toThrow(RangeError);
    });

    it("allows a queue of zero, which is fail-fast with no waiting at all", async () => {
      const limiter = bulkhead({ maxConcurrent: 1, maxQueued: 0 });
      const held = deferred();
      const running = limiter.run(() => held.promise);
      await flush();

      const error = await rejection(limiter.acquire());

      expect(error).toMatchObject({ reason: "queue-full" });

      held.resolve();
      await running;
    });
  });
});
