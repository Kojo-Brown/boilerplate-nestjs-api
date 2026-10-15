import fc from "fast-check";
import { DEFAULT_RUNS, DEFAULT_SEED, configureFastCheck } from "./fast-check";

describe("configureFastCheck()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    fc.resetConfigureGlobal();
  });

  it("applies the fixed default seed and run count", () => {
    delete process.env.FAST_CHECK_SEED;
    delete process.env.FAST_CHECK_RUNS;

    configureFastCheck();

    expect(fc.readConfigureGlobal()).toMatchObject({
      seed: DEFAULT_SEED,
      numRuns: DEFAULT_RUNS,
    });
  });

  it("lets a soak run override both", () => {
    process.env.FAST_CHECK_SEED = "42";
    process.env.FAST_CHECK_RUNS = "5000";

    configureFastCheck();

    expect(fc.readConfigureGlobal()).toMatchObject({ seed: 42, numRuns: 5000 });
  });

  it("treats an empty variable as unset", () => {
    // `FAST_CHECK_SEED=` in a shell script sets it to "", and `Number("")` is
    // 0 — which fast-check would read as a real seed.
    process.env.FAST_CHECK_SEED = "";

    configureFastCheck();

    expect(fc.readConfigureGlobal()).toMatchObject({ seed: DEFAULT_SEED });
  });

  it("refuses a value that is not a positive integer", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "1e400"]) {
      process.env.FAST_CHECK_SEED = bad;
      expect(() => configureFastCheck()).toThrow(
        `FAST_CHECK_SEED must be a positive integer, received "${bad}"`,
      );
    }
  });
});
