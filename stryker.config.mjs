// @ts-check

/**
 * Mutation testing.
 *
 * Coverage says a line ran. It does not say that anything would have noticed if
 * the line were wrong, and the two are routinely confused: `basket.ts` and
 * `money.ts` were both at 100% line coverage while nothing asserted that
 * `InvalidMoneyError`'s message named the amount it refused, that `TWD` was in
 * the zero-decimal set, or that `fromDecimalString` tolerated surrounding
 * whitespace. Stryker answers the question coverage cannot: it changes the code
 * and reports which changes the suite failed to notice. Every such *survivor*
 * is either a missing assertion or a line that does nothing.
 *
 * ## Why `mutate` is a list rather than `src/**`
 *
 * The suite is 3071 tests over 196 files, and a mutant costs a run of every
 * test that covers the line it sits on. Mutating all of `src` would be hours
 * per commit, and most of the result would be noise: a mutant inside a NestJS
 * module registration, a DTO decorator or a Prisma adapter mostly reports that
 * the thing under it is wiring rather than logic, and "survived" there means
 * "no unit test can see this" rather than "an assertion is missing".
 *
 * So the scope is the pure domain logic — total functions over plain values,
 * with their own specs, where a survivor is a real gap and a reviewer can act
 * on it in the same commit. Widening it is cheap and deliberate: add the file
 * here, run `pnpm test:mutation`, kill what survives. What does not belong here
 * is anything whose correctness is a property of Postgres, Redis, Kafka or
 * Nest's injector — those are covered by `test:db` and `test:e2e`, which this
 * runner does not execute.
 *
 * ## Why there is no `typescript` checker
 *
 * The usual pairing is `@stryker-mutator/typescript-checker`, which type-checks
 * each mutant so that one breaking the types is reported as a compile error and
 * left out of the denominator rather than counted as killed by accident. It
 * requires `disableTypeChecks: false`, and that does not work here: Stryker's
 * own instrumentation preamble does not compile under this `tsconfig.json`
 * (`strict`, `noImplicitAny`), so the dry run fails before any mutant is
 * created — `stryNS_9fa48 = retrieveNS` alone is a TS2630. With the default
 * `disableTypeChecks`, the sandbox copy gets `// @ts-nocheck` (never the
 * repository's own files) and the checker would have nothing left to check, so
 * it is not installed. The cost is that a type-invalid mutant counts as an
 * ordinary one; at this scope that is a handful of mutants, and they are killed
 * rather than survived, so the score it produces is if anything generous.
 */

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "jest",
  // Explicit, because plugin auto-discovery globs `node_modules/@stryker-mutator/*`
  // and finds nothing under pnpm's layout — the failure is an unhelpful
  // "no TestRunner plugins were loaded".
  plugins: ["@stryker-mutator/jest-runner"],

  jest: {
    configFile: "jest.config.ts",
    // Run only the tests that import the mutated file, rather than all 196
    // suites, for the dry run as well as for each mutant.
    enableFindRelatedTests: true,
  },

  // Per-test coverage, so a mutant is only run against the tests that actually
  // execute its line. The alternative ("all") runs every related test for every
  // mutant and roughly quadruples the wall clock here.
  coverageAnalysis: "perTest",

  mutate: [
    // Baskets: the merge and the per-SKU bound (see docs/tdd-kata.md).
    "src/orders/basket.ts",
    // Pricing: catalogue lookup, merge order, and the total.
    "src/orders/catalogue.ts",
    // Money: integer minor units, the zero-decimal set, and both string
    // conversions. Float-free arithmetic is exactly the kind of thing a mutant
    // finds an unasserted edge in.
    "src/payments/money.ts",
    // Cursor pagination: the limit + 1 fetch, and what becomes the next cursor.
    "src/common/pagination/build-cursor-page.ts",
    // Full-jitter backoff: the ladder every retry in the service is built from.
    "src/common/backoff/backoff.ts",
  ],

  // `break` fails the run, and is what the CI job is for. It sits below the
  // score the scoped files actually hold (100%) on purpose: a run is not
  // reproducible to the mutant, because a mutant that hangs is counted as
  // killed by a 5s timeout and a loaded runner can resolve one the other way.
  // One such mutant is ~0.6% here, so 95 is roughly eight mutants of slack —
  // enough that a busy runner cannot turn the job red on its own, and far too
  // little to absorb a deleted assertion.
  thresholds: { high: 100, low: 95, break: 95 },

  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  tempDirName: ".stryker-tmp",
};
