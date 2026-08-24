import { nextAttemptAt, nextAttemptDelayMs, type BackoffPolicy } from "./outbox-backoff";

const POLICY: BackoffPolicy = { baseMs: 500, maxMs: 300_000, maxAttempts: 8 };

/** The top of the jitter window, which is what the ladder is really about. */
const ceiling = (attempts: number) => nextAttemptDelayMs(attempts, POLICY, () => 0.999_999);

describe("nextAttemptDelayMs", () => {
  it("gives up once the attempts are spent", () => {
    expect(nextAttemptDelayMs(POLICY.maxAttempts, POLICY, () => 0.5)).toBeNull();
    expect(nextAttemptDelayMs(POLICY.maxAttempts + 1, POLICY, () => 0.5)).toBeNull();
  });

  it("still schedules the last attempt it is allowed", () => {
    expect(nextAttemptDelayMs(POLICY.maxAttempts - 1, POLICY, () => 0.5)).not.toBeNull();
  });

  it("waits around the base delay after the first failure, not twice it", () => {
    // `attempts` counts failures so far, so the first retry is 2^0 · base.
    expect(ceiling(1)).toBe(499);
  });

  it("doubles the window each time", () => {
    expect(ceiling(1)).toBe(499);
    expect(ceiling(2)).toBe(999);
    expect(ceiling(3)).toBe(1_999);
    expect(ceiling(4)).toBe(3_999);
  });

  it("plateaus at the ceiling instead of running away", () => {
    const flat: BackoffPolicy = { baseMs: 500, maxMs: 4_000, maxAttempts: 30 };
    expect(nextAttemptDelayMs(20, flat, () => 0.999_999)).toBe(3_999);
    expect(nextAttemptDelayMs(29, flat, () => 0.999_999)).toBe(3_999);
  });

  it("never overflows the exponent, however many attempts a policy allows", () => {
    const patient: BackoffPolicy = { baseMs: 500, maxMs: 300_000, maxAttempts: 1_000 };
    // 2 ** 999 is Infinity; the exponent is clamped so the ceiling stays finite.
    expect(nextAttemptDelayMs(999, patient, () => 0.5)).toBe(150_000);
  });

  /**
   * Full jitter, not "exponential plus a wobble".
   *
   * The whole delay is drawn from `[0, ceiling)`. A broker outage fails every
   * claimed row within a few milliseconds of the others, so a deterministic
   * ladder would schedule all of them for the same instant and the recovery
   * would arrive as a thundering herd against a broker that has just come back.
   */
  it("draws the whole delay from zero up to the ceiling", () => {
    expect(nextAttemptDelayMs(4, POLICY, () => 0)).toBe(0);
    expect(nextAttemptDelayMs(4, POLICY, () => 0.5)).toBe(2_000);
    expect(nextAttemptDelayMs(4, POLICY, () => 0.999_999)).toBe(3_999);
  });

  it("is never negative and never fractional", () => {
    for (let attempts = 1; attempts < POLICY.maxAttempts; attempts += 1) {
      for (const roll of [0, 0.25, 0.5, 0.75, 0.999_999]) {
        const delay = nextAttemptDelayMs(attempts, POLICY, () => roll);
        expect(delay).not.toBeNull();
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(delay)).toBe(true);
      }
    }
  });
});

describe("nextAttemptAt", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  it("offsets from the clock it is given", () => {
    expect(nextAttemptAt(now, 1, POLICY, () => 0.5)?.toISOString()).toBe(
      "2026-08-24T12:00:00.250Z",
    );
  });

  it("passes the dead-letter signal straight through", () => {
    expect(nextAttemptAt(now, POLICY.maxAttempts, POLICY, () => 0.5)).toBeNull();
  });
});
