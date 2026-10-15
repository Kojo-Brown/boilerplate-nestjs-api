import fc from "fast-check";

/**
 * Shared configuration for the property-based suites.
 *
 * A property test is only useful if a failure can be looked at, and fast-check
 * seeds itself from `Date.now()` by default: the run that fails is then a run
 * nobody can reproduce, including the next CI attempt on the same commit. A
 * mutation score with a `break` threshold makes that worse — a property that
 * finds a mutant four runs in five turns the gate into a coin toss.
 *
 * So the seed is fixed. The cases are the same on every machine and every run,
 * a failure reproduces from the commit alone, and the exploration happens when
 * somebody changes the seed rather than silently at 3am. `FAST_CHECK_SEED=…`
 * is how that is done — a soak run in a loop with a different seed each time
 * is worth doing after touching one of these helpers, and `FAST_CHECK_RUNS=…`
 * widens the same sweep.
 */
export const DEFAULT_SEED = 0x5eed_1337;

/** 200 rather than fast-check's 100: these properties are microseconds each. */
export const DEFAULT_RUNS = 200;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    // Loudly, rather than falling back: a typo'd seed that silently reverts to
    // the default looks exactly like a soak run that found nothing.
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return parsed;
}

/**
 * Applies the shared settings to fast-check's global configuration.
 *
 * Called at the top of each property suite rather than from a Jest setup file,
 * because it belongs to the suites that depend on it: a setup file would load
 * fast-check into all 196 of them and leave the coupling invisible from the
 * spec that relies on it.
 */
export function configureFastCheck(): void {
  fc.configureGlobal({
    seed: readPositiveInt("FAST_CHECK_SEED", DEFAULT_SEED),
    numRuns: readPositiveInt("FAST_CHECK_RUNS", DEFAULT_RUNS),
    // Report every counterexample fast-check found on the way to the shrunk
    // one. The shrunk value is what to fix; the path to it is what says
    // whether the property is finding one bug or a class of them.
    verbose: true,
  });
}
