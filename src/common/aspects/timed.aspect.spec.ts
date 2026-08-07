import { FakeAspectClock } from "@/test-utils/fake-aspect-clock";
import type { AspectContext, AspectInvocation } from "./aspect.types";
import type { MethodTiming } from "./ports";
import { applyTiming, resolveTimedOptions } from "./timed.aspect";
import type { TimedOptions } from "./timed.aspect";

const context: AspectContext = { target: "UsersService", method: "list" };

let clock: FakeAspectClock;
let samples: MethodTiming[];
let logger: { debug: jest.Mock; warn: jest.Mock };
let recorder: { record: jest.Mock };

const wrap = (next: AspectInvocation, options: TimedOptions = {}): AspectInvocation =>
  applyTiming(next, context, resolveTimedOptions(options), { clock, recorder, logger });

beforeEach(() => {
  clock = new FakeAspectClock();
  samples = [];
  logger = { debug: jest.fn(), warn: jest.fn() };
  recorder = { record: jest.fn((timing: MethodTiming) => samples.push(timing)) };
});

describe("resolveTimedOptions", () => {
  it.each([
    ["an empty name", { name: "" }],
    ["a negative threshold", { slowerThanMs: -1 }],
  ])("rejects %s at decoration time", (_label, options) => {
    expect(() => resolveTimedOptions(options)).toThrow(/@Timed/);
  });
});

describe("applyTiming", () => {
  it("records the elapsed time of a successful async call", async () => {
    const call = wrap(() => {
      clock.advance(25);
      return Promise.resolve("ok");
    });

    await expect(call([])).resolves.toBe("ok");
    expect(samples).toEqual([
      {
        name: "UsersService.list",
        target: "UsersService",
        method: "list",
        durationMs: 25,
        outcome: "success",
        slow: false,
      },
    ]);
  });

  it("uses the configured metric name over the derived one", async () => {
    const call = wrap(() => Promise.resolve(1), { name: "users.list" });

    await call([]);

    expect(samples[0]?.name).toBe("users.list");
  });

  it("records a rejection as a failure, with the error identified", async () => {
    const call = wrap(() => Promise.reject(new TypeError("bad shape")));

    await expect(call([])).rejects.toThrow(TypeError);
    expect(samples[0]).toMatchObject({
      outcome: "failure",
      error: { name: "TypeError", message: "bad shape" },
    });
  });

  it("records a non-Error rejection without losing it", async () => {
    const call = wrap(() => Promise.reject("just a string"));

    await expect(call([])).rejects.toBe("just a string");
    expect(samples[0]?.error).toEqual({ name: "string", message: "just a string" });
  });

  it("measures a synchronous method and returns its value unwrapped", () => {
    const call = wrap((args) => {
      clock.advance(3);
      return (args[0] as number) + 1;
    });

    // Not a promise: `@Timed()` must not change what a caller receives.
    expect(call([1])).toBe(2);
    expect(samples[0]).toMatchObject({ durationMs: 3, outcome: "success" });
  });

  it("records a synchronous throw as a failure and rethrows it", () => {
    const call = wrap(() => {
      throw new Error("sync boom");
    });

    expect(() => call([])).toThrow("sync boom");
    expect(samples[0]).toMatchObject({ outcome: "failure" });
  });

  it("flags a call at or above the slow threshold", async () => {
    const call = wrap(
      () => {
        clock.advance(200);
        return Promise.resolve("ok");
      },
      { slowerThanMs: 200 },
    );

    await call([]);

    expect(samples[0]?.slow).toBe(true);
  });

  it("leaves `slow` false when no threshold is configured", async () => {
    const call = wrap(() => {
      clock.advance(10_000);
      return Promise.resolve("ok");
    });

    await call([]);

    expect(samples[0]?.slow).toBe(false);
  });

  it("never fails a call because the recorder failed", async () => {
    recorder.record.mockImplementation(() => {
      throw new Error("metrics backend down");
    });
    const call = wrap(() => Promise.resolve("ok"));

    await expect(call([])).resolves.toBe("ok");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("records once per call, not once per subscriber", async () => {
    const call = wrap(() => Promise.resolve("ok"));

    const promise = call([]) as Promise<string>;
    await Promise.all([promise, promise]);

    expect(recorder.record).toHaveBeenCalledTimes(1);
  });
});
