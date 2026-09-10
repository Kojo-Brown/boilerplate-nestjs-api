import {
  HttpBulkheadRejectedError,
  HttpCircuitOpenError,
  HttpDeadlineExceededError,
  HttpTransportError,
} from "./http.errors";
import { ResilientHttpClient } from "./resilient-http.client";
import type { ResilientHttpOptions } from "./http-resilience";
import type { BulkheadPolicy, BulkheadStats } from "@/common/bulkhead";

const realFetch = global.fetch;

/** A response factory, because a `Response` body can only be read once. */
type Reply = () => Response;

function json(status: number, body: unknown = {}, headers: Record<string, string> = {}): Reply {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

/**
 * Answers each call with the next reply, repeating the last one once the list
 * is exhausted — so a test that expects two attempts says exactly two things
 * and a test that expects "always fails" says one.
 */
function respondWith(...replies: Array<Reply | Error>): jest.Mock {
  let index = 0;
  const mock = jest.fn(async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("respondWith needs at least one reply");
    return reply();
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

/**
 * A `fetch` that does not answer until this test says so.
 *
 * The concurrency cap can only be observed while calls are in flight, and a
 * mock that resolves on the next microtask is never in flight for long enough
 * to have a second one queue behind it. `release()` finishes everything
 * outstanding and answers anything that arrives afterwards, so a test never
 * ends with a request still parked.
 */
interface Upstream {
  readonly mock: jest.Mock;
  readonly release: () => void;
}

function hangs(): Upstream {
  const pending: Array<(response: Response) => void> = [];
  let released = false;
  const answer = (): Response =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const mock = jest.fn(async (_url: string, init: RequestInit) => {
    if (released) return answer();
    return new Promise<Response>((resolve, reject) => {
      pending.push(resolve);
      init.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });
  });

  global.fetch = mock as unknown as typeof fetch;
  return {
    mock,
    release: () => {
      released = true;
      for (const resolve of pending.splice(0)) resolve(answer());
    },
  };
}

/** Lets every already-scheduled microtask run, so pending state is settled state. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The error a call rejected with, so a test can assert on more than its type.
 *
 * `rejects.toBeInstanceOf` cannot also check a status and a message, and
 * `try`/`catch` around an `await` that is supposed to throw passes silently
 * when it does not.
 */
function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`Expected a rejection, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
}

const BULKHEAD: BulkheadPolicy = { maxConcurrent: 20, maxQueued: 20, maxQueueWaitMs: 1_000 };

/** What a dependency's bulkhead reports when nothing is holding it. */
function idleBulkhead(name: string, policy: BulkheadPolicy = BULKHEAD): BulkheadStats {
  return {
    name,
    inFlight: 0,
    queued: 0,
    maxConcurrent: policy.maxConcurrent,
    maxQueued: policy.maxQueued,
    queueFullRejections: 0,
    queueTimeoutRejections: 0,
  };
}

interface Harness {
  readonly client: ResilientHttpClient;
  readonly delays: number[];
}

function buildClient(overrides: Partial<ResilientHttpOptions> = {}): Harness {
  const delays: number[] = [];
  // The clock the deadline is measured on. It only moves when the ladder
  // sleeps, or when a test moves it, so a budget is spent in the same
  // milliseconds the schedule is asserted in rather than in real ones.
  let nowMs = 0;
  const options: ResilientHttpOptions = {
    retry: { maxAttempts: 3, baseMs: 100, maxMs: 1_000 },
    breaker: {
      failureThresholdPercent: 50,
      volumeThreshold: 5,
      rollingWindowMs: 10_000,
      rollingBuckets: 10,
      resetTimeoutMs: 30_000,
    },
    // Wide enough that only the tests about it ever reach it: every other test
    // here makes its calls one at a time.
    bulkhead: BULKHEAD,
    deadlineMs: 25_000,
    // Resolves immediately but still costs the budget it asked for: the
    // ladder's schedule is asserted on, never waited out. A suite that really
    // slept its own backoff would take 4.5 seconds to prove arithmetic.
    sleep: async (ms) => {
      delays.push(ms);
      nowMs += ms;
    },
    // Full jitter draws uniformly below the ceiling, so a fixed draw makes each
    // delay a single number a test can name: 0.5 is half of it.
    random: () => 0.5,
    now: () => nowMs,
    ...overrides,
  };
  return { client: new ResilientHttpClient(options), delays };
}

describe("ResilientHttpClient", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildClient();
  });

  afterEach(() => {
    harness.client.onApplicationShutdown();
    global.fetch = realFetch;
  });

  describe("responses that are not failures", () => {
    it("returns a 2xx body without retrying", async () => {
      const fetchMock = respondWith(json(200, { id: "pi_1" }));

      const response = await harness.client.request("stripe", "https://api.test/v1/things", {
        method: "GET",
      });

      expect(response).toMatchObject({ status: 200, ok: true, body: { id: "pi_1" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.delays).toEqual([]);
    });

    it("returns a 4xx to the caller unchanged, without spending an attempt on it", async () => {
      const fetchMock = respondWith(json(404, { error: { code: "resource_missing" } }));

      const response = await harness.client.request("stripe", "https://api.test/v1/things/x", {
        method: "GET",
      });

      // A 404 is an answer. Deciding what it means is the adapter's job — for
      // `find()` it is `null`, for `capture()` it is an error — and the client
      // must not turn it into either.
      expect(response.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not count 4xx answers against the breaker", async () => {
      respondWith(json(422, { message: "no" }));

      for (let i = 0; i < 10; i += 1) {
        await harness.client.request("paypal", "https://api.test/v2/orders", { method: "GET" });
      }

      // Ten failures in a row on any other reading, and the volume threshold is
      // five. A dependency answering "no" promptly is a healthy dependency, and
      // a breaker that opened here would be causing the outage rather than
      // containing one.
      expect(harness.client.snapshot()).toEqual([
        {
          dependency: "paypal",
          state: "closed",
          successes: 10,
          failures: 0,
          rejects: 0,
          bulkhead: idleBulkhead("paypal"),
        },
      ]);
    });
  });

  describe("the retry ladder", () => {
    it("retries a safe method on a 5xx and returns the attempt that worked", async () => {
      const fetchMock = respondWith(json(503), json(200, { id: "pi_1" }));

      const response = await harness.client.request("stripe", "https://api.test/v1/things", {
        method: "GET",
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Full jitter over the first ceiling: `random() · min(maxMs, base · 2⁰)`.
      expect(harness.delays).toEqual([50]);
    });

    it("doubles the ceiling each attempt and returns the last response when spent", async () => {
      const fetchMock = respondWith(json(500, { message: "boom" }));

      const response = await harness.client.request("stripe", "https://api.test/v1/things", {
        method: "GET",
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(harness.delays).toEqual([50, 100]);
      // The upstream's own body survives the ladder, because the adapter reads
      // it to tell a declined card from a dead gateway.
      expect(response).toMatchObject({ status: 500, ok: false, body: { message: "boom" } });
    });

    it("retries 408 and 429 as well as 5xx", async () => {
      for (const status of [408, 429]) {
        const local = buildClient();
        const fetchMock = respondWith(json(status), json(200));

        await local.client.request("stripe", "https://api.test/v1/things", { method: "GET" });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        local.client.onApplicationShutdown();
      }
    });

    it("does not retry a POST by default", async () => {
      const fetchMock = respondWith(json(503));

      const response = await harness.client.request("sms", "https://api.test/Messages.json", {
        method: "POST",
        body: "To=%2B15550100",
      });

      // A retry is a second attempt at a request whose first outcome is
      // unknown. For Twilio that is a second text message, so the breaker
      // protects the call and the ladder stays out of it.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(503);
      expect(harness.delays).toEqual([]);
    });

    it("retries a POST that declares itself idempotent", async () => {
      const fetchMock = respondWith(json(502), json(200, { id: "pi_1" }));

      const response = await harness.client.request(
        "stripe",
        "https://api.test/v1/payment_intents",
        { method: "POST", headers: { "Idempotency-Key": "authorize:order-1" } },
        { idempotent: true },
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honours Retry-After in seconds, with a jitter draw on top", async () => {
      const fetchMock = respondWith(json(429, {}, { "retry-after": "1" }), json(200));

      await harness.client.request("stripe", "https://api.test/v1/things", { method: "GET" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The upstream's number, plus `random() · baseMs`: every client throttled
      // in the same second is told the same thing, so obeying it exactly would
      // rebuild the herd the ladder exists to break up.
      expect(harness.delays).toEqual([1_050]);
    });

    it("gives up rather than sleeping for a Retry-After longer than the ceiling", async () => {
      const fetchMock = respondWith(json(429, { message: "slow down" }, { "retry-after": "300" }));

      const response = await harness.client.request("stripe", "https://api.test/v1/things", {
        method: "GET",
      });

      // Somebody is waiting on this request. Five minutes of sleeping inside it
      // is a worse answer than the 429 the caller can act on.
      expect(response.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.delays).toEqual([]);
    });

    it("wraps a transport failure once the ladder is spent", async () => {
      const fetchMock = respondWith(new TypeError("fetch failed"));

      await expect(
        harness.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      ).rejects.toThrow(HttpTransportError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("reports the attempt count and the underlying failure on the transport error", async () => {
      respondWith(new TypeError("fetch failed"));

      const error = await harness.client
        .request("stripe", "https://api.test/v1/things", { method: "GET" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpTransportError);
      const transport = error as HttpTransportError;
      expect(transport.getStatus()).toBe(502);
      expect(transport.dependency).toBe("stripe");
      expect(transport.attempts).toBe(3);
      expect(transport.message).toContain("TypeError: fetch failed");
    });
  });

  describe("the circuit breaker", () => {
    it("opens after the failure rate passes the threshold and then stops sending", async () => {
      const fetchMock = respondWith(json(503));

      // Five POSTs, one attempt each: the volume threshold exactly.
      for (let i = 0; i < 5; i += 1) {
        await harness.client.request("stripe", "https://api.test/v1/things", { method: "POST" });
      }
      expect(fetchMock).toHaveBeenCalledTimes(5);

      await expect(
        harness.client.request("stripe", "https://api.test/v1/things", { method: "POST" }),
      ).rejects.toThrow(HttpCircuitOpenError);
      // The sixth call never reached the network, which is the whole point:
      // the dependency gets to recover instead of being held down.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("fails fast instead of spending the ladder against an open circuit", async () => {
      respondWith(json(503));

      for (let i = 0; i < 5; i += 1) {
        await harness.client.request("stripe", "https://api.test/v1/things", { method: "POST" });
      }

      const before = harness.delays.length;
      await expect(
        harness.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      ).rejects.toThrow(HttpCircuitOpenError);

      // A rejected call costs nothing and tells us nothing, so retrying it
      // three times is three times nothing. The breaker's reset timeout is the
      // only wait that means anything here.
      expect(harness.delays.length).toBe(before);
    });

    it("reports the reset timeout on the error, as a 503", async () => {
      respondWith(json(503));
      for (let i = 0; i < 5; i += 1) {
        await harness.client.request("stripe", "https://api.test/v1/things", { method: "POST" });
      }

      const error = await harness.client
        .request("stripe", "https://api.test/v1/things", { method: "POST" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpCircuitOpenError);
      const open = error as HttpCircuitOpenError;
      expect(open.getStatus()).toBe(503);
      expect(open.retryAfterMs).toBe(30_000);
      expect(open.dependency).toBe("stripe");
    });

    it("keeps one breaker per dependency", async () => {
      const fetchMock = respondWith(json(503));
      for (let i = 0; i < 5; i += 1) {
        await harness.client.request("stripe", "https://api.test/v1/things", { method: "POST" });
      }

      // Stripe is out. PayPal is a different company on a different network and
      // has done nothing wrong; one breaker for "outbound HTTP" would have
      // taken it down too.
      respondWith(json(200, { id: "order-1" }));
      const response = await harness.client.request("paypal", "https://paypal.test/v2/orders", {
        method: "GET",
      });

      expect(response.status).toBe(200);
      expect(harness.client.snapshot()).toEqual([
        {
          dependency: "stripe",
          state: "open",
          successes: 0,
          failures: 5,
          rejects: 0,
          bulkhead: idleBulkhead("stripe"),
        },
        {
          dependency: "paypal",
          state: "closed",
          successes: 1,
          failures: 0,
          rejects: 0,
          bulkhead: idleBulkhead("paypal"),
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("admits a probe once the reset timeout has elapsed, and closes on success", async () => {
      const local = buildClient({
        breaker: {
          failureThresholdPercent: 50,
          volumeThreshold: 5,
          rollingWindowMs: 10_000,
          rollingBuckets: 10,
          // Short enough to wait out for real: the reset is opossum's own
          // timer, and faking it would be testing the fake.
          resetTimeoutMs: 20,
        },
      });
      respondWith(json(503));
      for (let i = 0; i < 5; i += 1) {
        await local.client.request("stripe", "https://api.test/v1/things", { method: "POST" });
      }
      expect(local.client.snapshot()[0]?.state).toBe("open");

      await new Promise((resolve) => setTimeout(resolve, 40));
      respondWith(json(200));
      const response = await local.client.request("stripe", "https://api.test/v1/things", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(local.client.snapshot()[0]?.state).toBe("closed");
      local.client.onApplicationShutdown();
    });

    it("reports nothing until a dependency has been called", () => {
      expect(harness.client.snapshot()).toEqual([]);
    });

    it("shuts its breakers down and forgets them", async () => {
      respondWith(json(200));
      await harness.client.request("stripe", "https://api.test/v1/things", { method: "GET" });
      expect(harness.client.snapshot()).toHaveLength(1);

      harness.client.onApplicationShutdown();

      expect(harness.client.snapshot()).toEqual([]);
    });
  });

  describe("the bulkhead", () => {
    const POLICY: BulkheadPolicy = { maxConcurrent: 2, maxQueued: 1, maxQueueWaitMs: 1_000 };

    it("holds the cap open and queues what arrives over it", async () => {
      const local = buildClient({ bulkhead: POLICY });
      const upstream = hangs();

      const inFlight = [1, 2].map(() =>
        local.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      );
      await flush();
      expect(upstream.mock).toHaveBeenCalledTimes(2);

      const queued = local.client.request("stripe", "https://api.test/v1/things", {
        method: "GET",
      });
      await flush();

      // The third call exists and the dependency has not been asked to do a
      // third thing. That is the whole pattern: a slow dependency gets a
      // bounded amount of this process, not all of it.
      expect(upstream.mock).toHaveBeenCalledTimes(2);
      expect(local.client.snapshot()[0]?.bulkhead).toMatchObject({ inFlight: 2, queued: 1 });

      upstream.release();
      await Promise.all([...inFlight, queued]);

      expect(upstream.mock).toHaveBeenCalledTimes(3);
      expect(local.client.snapshot()[0]?.bulkhead).toMatchObject({ inFlight: 0, queued: 0 });
      local.client.onApplicationShutdown();
    });

    it("refuses a call with a 503 once the cap and the queue are both full", async () => {
      const local = buildClient({ bulkhead: POLICY });
      const upstream = hangs();
      const held = [1, 2, 3].map(() =>
        local.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      );
      await flush();

      const error = await capture(
        local.client.request(
          "stripe",
          "https://api.test/v1/things",
          { method: "POST" },
          { idempotent: true },
        ),
      );

      expect(error).toBeInstanceOf(HttpBulkheadRejectedError);
      expect((error as HttpBulkheadRejectedError).getStatus()).toBe(503);
      expect((error as HttpBulkheadRejectedError).cause.reason).toBe("queue-full");
      // Never sent, and never retried: the ladder would queue again behind the
      // same saturated dependency and spend the caller's budget to arrive at
      // the same answer more slowly.
      expect(upstream.mock).toHaveBeenCalledTimes(2);
      expect(local.delays).toEqual([]);

      upstream.release();
      await Promise.all(held);
      local.client.onApplicationShutdown();
    });

    it("does not count its own back-pressure against the dependency's breaker", async () => {
      const local = buildClient({
        bulkhead: { maxConcurrent: 1, maxQueued: 0, maxQueueWaitMs: 1_000 },
      });
      const upstream = hangs();
      const held = local.client.request("stripe", "https://api.test/v1/things", { method: "GET" });
      await flush();

      for (let i = 0; i < 6; i += 1) {
        await expect(
          local.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
        ).rejects.toBeInstanceOf(HttpBulkheadRejectedError);
      }

      // Six rejections against a volume threshold of five and a 50% failure
      // rate. This is the reason the bulkhead is not opossum's `capacity`:
      // opossum files a semaphore rejection through `handleError`, so it lands
      // in `stats.failures` and counts toward the error percentage — enough of
      // our own back-pressure would open the breaker and take a dependency
      // that has answered nothing wrong out for the whole reset timeout.
      const [snapshot] = local.client.snapshot();
      expect(snapshot).toMatchObject({ state: "closed", failures: 0, successes: 0 });
      expect(snapshot?.bulkhead).toMatchObject({ inFlight: 1, queueFullRejections: 6 });

      upstream.release();
      await held;
      local.client.onApplicationShutdown();
    });

    it("keeps one bulkhead per dependency", async () => {
      const local = buildClient({
        bulkhead: { maxConcurrent: 1, maxQueued: 0, maxQueueWaitMs: 1_000 },
      });
      const upstream = hangs();
      const held = local.client.request("stripe", "https://api.test/v1/things", { method: "GET" });
      await flush();

      await expect(
        local.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      ).rejects.toBeInstanceOf(HttpBulkheadRejectedError);

      // Stripe being slow must not make Twilio unreachable — the same reason
      // there is one breaker per dependency rather than one for "outbound
      // HTTP".
      upstream.release();
      const response = await local.client.request("sms", "https://twilio.test/Messages", {
        method: "GET",
      });

      expect(response.status).toBe(200);
      await held;
      local.client.onApplicationShutdown();
    });
  });

  describe("the request deadline", () => {
    it("returns the last response when the next sleep would outlast the budget", async () => {
      const local = buildClient();
      const fetchMock = respondWith(json(503, { message: "still starting up" }));

      const response = await local.client.request(
        "stripe",
        "https://api.test/v1/things",
        { method: "GET" },
        { deadlineMs: 150 },
      );

      // Attempt one sleeps 50ms of the 150ms budget; attempt two would need
      // 100ms of the 100ms left, so the ladder stops with an attempt still
      // unspent. The caller gets the 503 rather than a deadline error, because
      // a status is data whichever limit ended the call.
      expect(response.status).toBe(503);
      expect(local.delays).toEqual([50]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      local.client.onApplicationShutdown();
    });

    it("gives up with a 504 when the budget runs out with nothing to return", async () => {
      const local = buildClient();
      respondWith(new TypeError("fetch failed"));

      const error = await capture(
        local.client.request(
          "stripe",
          "https://api.test/v1/things",
          { method: "GET" },
          { deadlineMs: 150 },
        ),
      );

      expect(error).toBeInstanceOf(HttpDeadlineExceededError);
      expect((error as HttpDeadlineExceededError).getStatus()).toBe(504);
      // A transport error would say the ladder was spent, which it was not:
      // two of three attempts fitted in the budget, and the budget is what
      // ended the call.
      expect((error as Error).message).toContain("exceeded its 150ms budget after 2 attempts");
      expect(local.delays).toEqual([50]);
      local.client.onApplicationShutdown();
    });

    it("clamps an attempt's socket timeout to what is left of the budget", async () => {
      // The one group that runs on the real clock: `AbortSignal.timeout` is a
      // real timer, so the thing under test — that the attempt is cut off by
      // the budget rather than by its own generous timeout — can only be
      // observed in real milliseconds.
      const local = buildClient({ now: () => performance.now() });
      const upstream = hangs();

      const started = performance.now();
      const error = await capture(
        local.client.request(
          "stripe",
          "https://api.test/v1/things",
          { method: "GET" },
          { timeoutMs: 30_000, deadlineMs: 80 },
        ),
      );
      const elapsedMs = performance.now() - started;

      expect(error).toBeInstanceOf(HttpDeadlineExceededError);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(upstream.mock).toHaveBeenCalledTimes(1);
      upstream.release();
      local.client.onApplicationShutdown();
    });

    it("sends nothing when the budget is already gone by the time a permit is free", async () => {
      // The clock is read to set the deadline, again at the top of the loop,
      // and again once a permit is in hand. Jumping on that third read is the
      // queue wait having consumed the whole budget, expressed without racing
      // a real one.
      let reads = 0;
      const local = buildClient({
        now: () => (reads++ < 2 ? 0 : 1_000),
        deadlineMs: 100,
      });
      const fetchMock = respondWith(json(200));

      const error = await capture(
        local.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      );

      expect(error).toBeInstanceOf(HttpDeadlineExceededError);
      expect((error as Error).message).toContain("exceeded its 100ms budget after 0 attempts");
      expect(fetchMock).not.toHaveBeenCalled();
      local.client.onApplicationShutdown();
    });

    it("returns the response that bought a sleep when the sleep overshot the budget", async () => {
      // A timer guarantees a floor, not a ceiling: an event loop busy with
      // somebody else's work can turn a 50ms sleep into a 1s one, and the
      // ladder cannot schedule its way out of that.
      let clock = 0;
      const local = buildClient({
        deadlineMs: 100,
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
      });
      respondWith(json(503, { message: "still starting up" }));

      const response = await local.client.request("stripe", "https://api.test/v1/things", {
        method: "GET",
      });

      // The 503 is a worse answer than a 200 and a better one than a 504 that
      // says nothing at all about the dependency.
      expect(response.status).toBe(503);
      local.client.onApplicationShutdown();
    });

    it("reports the deadline when an overshooting sleep leaves nothing to return", async () => {
      let clock = 0;
      const local = buildClient({
        deadlineMs: 100,
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
      });
      respondWith(new TypeError("fetch failed"));

      const error = await capture(
        local.client.request("stripe", "https://api.test/v1/things", { method: "GET" }),
      );

      expect(error).toBeInstanceOf(HttpDeadlineExceededError);
      expect((error as Error).message).toContain("exceeded its 100ms budget after 1 attempt");
      local.client.onApplicationShutdown();
    });

    it("counts the wait for a bulkhead permit against the budget", async () => {
      const local = buildClient({
        bulkhead: { maxConcurrent: 1, maxQueued: 4, maxQueueWaitMs: 10_000 },
        now: () => performance.now(),
      });
      const upstream = hangs();
      const held = local.client.request(
        "stripe",
        "https://api.test/v1/things",
        { method: "GET" },
        { timeoutMs: 30_000, deadlineMs: 30_000 },
      );
      await flush();

      const error = await capture(
        local.client.request(
          "stripe",
          "https://api.test/v1/things",
          { method: "GET" },
          { deadlineMs: 60 },
        ),
      );

      // A caller with 60ms left does not queue for the ten seconds the policy
      // would otherwise allow: the wait is the smaller of the two, so the
      // rejection arrives while the caller is still waiting for it.
      expect(error).toBeInstanceOf(HttpBulkheadRejectedError);
      expect((error as HttpBulkheadRejectedError).cause.reason).toBe("queue-timeout");
      expect(upstream.mock).toHaveBeenCalledTimes(1);

      upstream.release();
      await held;
      local.client.onApplicationShutdown();
    });
  });
});
