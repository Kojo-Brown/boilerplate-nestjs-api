import { HttpCircuitOpenError, HttpTransportError } from "./http.errors";
import { ResilientHttpClient } from "./resilient-http.client";
import type { ResilientHttpOptions } from "./http-resilience";

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

interface Harness {
  readonly client: ResilientHttpClient;
  readonly delays: number[];
}

function buildClient(overrides: Partial<ResilientHttpOptions> = {}): Harness {
  const delays: number[] = [];
  const options: ResilientHttpOptions = {
    retry: { maxAttempts: 3, baseMs: 100, maxMs: 1_000 },
    breaker: {
      failureThresholdPercent: 50,
      volumeThreshold: 5,
      rollingWindowMs: 10_000,
      rollingBuckets: 10,
      resetTimeoutMs: 30_000,
    },
    // Resolves immediately: the ladder's schedule is asserted on, never waited
    // out. A suite that really slept its own backoff would take 4.5 seconds to
    // prove arithmetic.
    sleep: async (ms) => {
      delays.push(ms);
    },
    // Full jitter draws uniformly below the ceiling, so a fixed draw makes each
    // delay a single number a test can name: 0.5 is half of it.
    random: () => 0.5,
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
        { dependency: "paypal", state: "closed", successes: 10, failures: 0, rejects: 0 },
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
        { dependency: "stripe", state: "open", successes: 0, failures: 5, rejects: 0 },
        { dependency: "paypal", state: "closed", successes: 1, failures: 0, rejects: 0 },
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
});
