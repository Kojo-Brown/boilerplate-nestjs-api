import { ResilientHttpClient } from "@/common/http";
import type { ResilientHttpOptions } from "@/common/http";

/**
 * A `ResilientHttpClient` for the specs of the adapters that use one.
 *
 * Two departures from production, and both are the point:
 *  - `sleep` resolves immediately and records what it was asked to wait, so a
 *    suite that exercises a three-attempt ladder finishes in microseconds and
 *    can still assert on the schedule.
 *  - `random` is fixed rather than `Math.random`, so full jitter is a number a
 *    test can predict instead of a range it has to tolerate.
 *
 * The policy is otherwise the real one. An adapter spec that wants no retrying
 * at all — most of them, since they assert on what the fake API received —
 * passes `maxAttempts: 1`; the breaker and the bulkhead stay in the path either
 * way, which is what keeps these specs honest about the wiring.
 *
 * `now` is the real monotonic clock: an adapter spec's calls are sequential and
 * its `sleep` returns instantly, so nothing gets near the deadline. A spec that
 * wants to exercise the budget passes a clock it steps itself.
 */
export interface TestHttpClient {
  readonly client: ResilientHttpClient;
  /** Every delay the ladder asked for, in order. */
  readonly delays: number[];
}

export function testHttpClient(overrides: Partial<ResilientHttpOptions> = {}): TestHttpClient {
  const delays: number[] = [];

  const options: ResilientHttpOptions = {
    retry: { maxAttempts: 1, baseMs: 100, maxMs: 1_000 },
    breaker: {
      failureThresholdPercent: 50,
      volumeThreshold: 5,
      rollingWindowMs: 10_000,
      rollingBuckets: 10,
      resetTimeoutMs: 30_000,
    },
    bulkhead: { maxConcurrent: 20, maxQueued: 20, maxQueueWaitMs: 1_000 },
    deadlineMs: 25_000,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    now: () => performance.now(),
    ...overrides,
  };

  return { client: new ResilientHttpClient(options), delays };
}
