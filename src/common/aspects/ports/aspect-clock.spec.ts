import { SystemAspectClock } from "./aspect-clock.port";
import { SystemAspectRandom } from "./aspect-random.port";

describe("SystemAspectClock", () => {
  const clock = new SystemAspectClock();

  it("reads wall-clock milliseconds", () => {
    const before = Date.now();
    const now = clock.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("waits for at least the requested delay", async () => {
    const startedAt = clock.now();
    await clock.sleep(15);

    // Timers may fire a millisecond early on some platforms; the point of the
    // assertion is that it waited, not that it waited precisely.
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(14);
  });

  it.each([0, -1])("returns immediately for a delay of %s", async (ms) => {
    const startedAt = clock.now();
    await clock.sleep(ms);

    expect(clock.now() - startedAt).toBeLessThan(10);
  });
});

describe("SystemAspectRandom", () => {
  it("stays within [0, 1)", () => {
    const random = new SystemAspectRandom();

    for (let i = 0; i < 100; i += 1) {
      const value = random.nextFraction();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
