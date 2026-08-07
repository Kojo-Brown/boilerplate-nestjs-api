import {
  BadRequestException,
  InternalServerErrorException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { FakeAspectClock, FakeAspectRandom } from "@/test-utils/fake-aspect-clock";
import { AspectUsageError } from "./aspect.types";
import type { AspectContext, AspectInvocation } from "./aspect.types";
import {
  DEFAULT_RETRY_OPTIONS,
  applyRetry,
  computeRetryDelay,
  isTransientError,
  resolveRetryOptions,
} from "./retry.aspect";

const context: AspectContext = { target: "PaymentsService", method: "capture" };
const silentLogger = { debug: jest.fn(), warn: jest.fn() };

const wrap = (
  next: AspectInvocation,
  overrides: Parameters<typeof resolveRetryOptions>[0] = {},
  clock = new FakeAspectClock(),
  random = new FakeAspectRandom([1]),
): { call: AspectInvocation; clock: FakeAspectClock } => ({
  call: applyRetry(next, context, resolveRetryOptions({ jitter: false, ...overrides }), {
    clock,
    random,
    logger: silentLogger,
  }),
  clock,
});

beforeEach(() => jest.clearAllMocks());

describe("isTransientError", () => {
  it("retries 5xx responses", () => {
    expect(isTransientError(new InternalServerErrorException())).toBe(true);
    expect(isTransientError(new ServiceUnavailableException())).toBe(true);
  });

  it("does not retry a 4xx the caller caused", () => {
    expect(isTransientError(new BadRequestException())).toBe(false);
  });

  it("retries the two 4xx statuses that describe a passing condition", () => {
    expect(isTransientError(new RequestTimeoutException())).toBe(true);
    expect(isTransientError(new ThrottlerException())).toBe(true);
  });

  it("retries anything that is not an HttpException", () => {
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError("not even an error")).toBe(true);
  });
});

describe("resolveRetryOptions", () => {
  it("fills in the documented defaults", () => {
    expect(resolveRetryOptions()).toMatchObject(DEFAULT_RETRY_OPTIONS);
  });

  it("ignores explicitly undefined fields instead of overwriting a default", () => {
    expect(resolveRetryOptions({ attempts: undefined }).attempts).toBe(
      DEFAULT_RETRY_OPTIONS.attempts,
    );
  });

  it.each([
    ["attempts", { attempts: 0 }],
    ["a fractional attempts", { attempts: 1.5 }],
    ["delayMs", { delayMs: -1 }],
    ["factor", { factor: 0.5 }],
    ["maxDelayMs below delayMs", { delayMs: 500, maxDelayMs: 100 }],
  ])("rejects %s at decoration time", (_label, options) => {
    expect(() => resolveRetryOptions(options)).toThrow(/@Retry/);
  });
});

describe("computeRetryDelay", () => {
  const options = resolveRetryOptions({ delayMs: 100, factor: 2, maxDelayMs: 10_000 });

  it("doubles per attempt when the backoff is exponential", () => {
    expect(computeRetryDelay(1, { ...options, jitter: false }, 1)).toBe(100);
    expect(computeRetryDelay(2, { ...options, jitter: false }, 1)).toBe(200);
    expect(computeRetryDelay(3, { ...options, jitter: false }, 1)).toBe(400);
  });

  it("holds the base delay when the backoff is fixed", () => {
    const fixed = { ...options, backoff: "fixed" as const, jitter: false };
    expect(computeRetryDelay(3, fixed, 1)).toBe(100);
  });

  it("caps growth at maxDelayMs", () => {
    const capped = { ...options, maxDelayMs: 250, jitter: false };
    expect(computeRetryDelay(5, capped, 1)).toBe(250);
  });

  it("spreads the delay over [0, computed) when jitter is on", () => {
    const jittered = { ...options, jitter: true };
    expect(computeRetryDelay(2, jittered, 0)).toBe(0);
    expect(computeRetryDelay(2, jittered, 0.25)).toBe(50);
    expect(computeRetryDelay(2, jittered, 0.999)).toBe(200);
  });
});

describe("applyRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    const next = jest.fn().mockResolvedValue("ok");
    const { call, clock } = wrap(next);

    await expect(call(["a"])).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("passes the original arguments through on every attempt", async () => {
    const next = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const { call } = wrap(next);

    await expect(call(["a", 1])).resolves.toBe("ok");
    expect(next).toHaveBeenNthCalledWith(1, ["a", 1]);
    expect(next).toHaveBeenNthCalledWith(2, ["a", 1]);
  });

  it("retries until it succeeds, backing off in between", async () => {
    const next = jest
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValueOnce("ok");
    const { call, clock } = wrap(next, { attempts: 3, delayMs: 100 });

    await expect(call([])).resolves.toBe("ok");
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it("gives up after `attempts` and rethrows the last error", async () => {
    const next = jest.fn().mockRejectedValue(new Error("still down"));
    const { call, clock } = wrap(next, { attempts: 3, delayMs: 50 });

    await expect(call([])).rejects.toThrow("still down");
    expect(next).toHaveBeenCalledTimes(3);
    // Three attempts means two waits: nothing sleeps after the final failure.
    expect(clock.sleeps).toEqual([50, 100]);
  });

  it("does not retry at all when attempts is 1", async () => {
    const next = jest.fn().mockRejectedValue(new Error("down"));
    const { call } = wrap(next, { attempts: 1 });

    await expect(call([])).rejects.toThrow("down");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on a non-transient failure", async () => {
    const next = jest.fn().mockRejectedValue(new BadRequestException("bad id"));
    const { call } = wrap(next, { attempts: 5 });

    await expect(call([])).rejects.toThrow(BadRequestException);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("honours a custom retryIf, with the 1-based attempt number", async () => {
    const retryIf = jest.fn().mockReturnValue(false);
    const next = jest.fn().mockRejectedValue(new Error("nope"));
    const { call } = wrap(next, { attempts: 5, retryIf });

    await expect(call([])).rejects.toThrow("nope");
    expect(retryIf).toHaveBeenCalledWith(expect.any(Error), 1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("retries a synchronous throw as well as a rejection", async () => {
    const next = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("threw");
      })
      .mockResolvedValueOnce("ok");
    const { call } = wrap(next);

    await expect(call([])).resolves.toBe("ok");
  });

  it("refuses a method that does not return a promise, and does not retry it", async () => {
    const next = jest.fn().mockReturnValue("synchronous");
    const { call } = wrap(next, { attempts: 3 });

    await expect(call([])).rejects.toThrow(AspectUsageError);
    // A misapplied decorator will fail identically on every attempt.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("draws fresh jitter for each attempt", async () => {
    const next = jest.fn().mockRejectedValue(new Error("down"));
    const clock = new FakeAspectClock();
    const { call } = wrap(
      next,
      { attempts: 3, delayMs: 100, jitter: true },
      clock,
      new FakeAspectRandom([0.5, 0.25]),
    );

    await expect(call([])).rejects.toThrow("down");
    expect(clock.sleeps).toEqual([50, 50]);
  });
});
