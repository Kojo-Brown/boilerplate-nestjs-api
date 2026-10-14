# Mutation testing

`pnpm test:mutation` runs [Stryker](https://stryker-mutator.io) over the pure
domain logic listed in `stryker.config.mjs`. The `Mutation Score` job in CI runs
the same command and fails the build below `thresholds.break`.

## What it is for

Line coverage says a line ran. It does not say that anything would have noticed
the line being wrong, and the two get conflated — the first run of this tool
found eight unasserted behaviours in files that were already at 100% line
coverage:

| What was mutated                                     | What the suite did | Why it mattered                                                                                                   |
| ---------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ZERO_DECIMAL_CURRENCIES`: `"TWD"` → `""`            | stayed green       | `1000 TWD` would have gone to PayPal as `"10.00"` — a hundredth of the amount, accepted without complaint         |
| `fromDecimalString`: `value.trim()` → `value`        | stayed green       | every amount a provider sent with surrounding whitespace would have become "not a decimal number"                 |
| five `InvalidMoneyError` messages → ` ` ``           | stayed green       | the type told an on-call engineer which of three checks fired, never what was in the request                      |
| `InvalidMoneyError`: `this.name` → `""`              | stayed green       | every log line, response body and Sentry group for this module's errors would have read `Error`                   |
| `buildCursorPage`: `lastItem !== undefined` → `true` | stayed green       | at `limit: 0` the default `getId` reads `.id` off `undefined` and throws a `TypeError` out of a pure function     |
| four `PRODUCT_CATALOGUE` names → `""`                | stayed green       | `name` is the one catalogue field `priceOrder` does not read, so nothing asserted the price list had names at all |

Each was fixed by adding an assertion, never by narrowing the scope, and the
score is now 100% over 168 mutants. That number is not the interesting part —
the survivors were. A run that reports 100% has told you nothing you did not
already have; a run that reports a survivor has handed you a test to write.

## Reading a run

```
[Survived] StringLiteral
src/payments/money.ts:23:77
-   const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["HUF", "JPY", "TWD"]);
+   const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["HUF", "JPY", ""]);
```

A **survivor** is the output worth reading: Stryker made that change and the
whole suite still passed. It is one of three things, in rough order of how often
it is each:

1. **A missing assertion.** Write it. All fourteen survivors of the first run
   were this.
2. **A line that does nothing.** Delete it.
3. **An equivalent mutant** — a change that cannot alter observable behaviour,
   so no test could kill it. These exist and are not a failure of the suite.
   Mark one with a comment naming the reason, never by removing the file from
   `mutate`:

   ```ts
   // Stryker disable next-line ArrayDeclaration: <why no test can see this>
   ```

   There are none in the tree today, which is why there is no live example.

`# timeout` counts as killed: a mutant that turns a bounded loop into an endless
one is detected by the 5s timeout rather than by an assertion, and that is a
real detection. Seven of the mutants in `backoff.ts` are this — `worstCaseLadderMs`
iterates to `maxAttempts`, and most mutations of that condition never terminate.

The HTML report (`reports/mutation/index.html`, and a CI artifact on every run)
is the same information per line of source, which is the easier way to read more
than a couple of survivors.

## Scope: why `mutate` is a list

```
src/orders/basket.ts                      src/payments/money.ts
src/orders/catalogue.ts                   src/common/backoff/backoff.ts
src/common/pagination/build-cursor-page.ts
```

The suite is 3071 tests over 196 files and a mutant costs a run of every test
covering its line. `src/**` would be hours per commit, and most of the result
would be noise: a survivor inside a module registration, a DTO decorator or a
Prisma adapter usually reports that the thing under it is wiring rather than
logic, which is not a missing assertion and not actionable in the same commit.

So the scope is total functions over plain values, with their own specs, where a
survivor is a real gap. Correctness that is a property of Postgres, Redis, Kafka
or Nest's injector is covered by `test:db` and `test:e2e` instead — neither of
which this runner executes, which is also why the CI job needs no services.

**Widening it is the normal way to use this.** Add the file to `mutate`, run
`pnpm test:mutation`, kill what survives, and keep it in the same PR as the
assertions that kill it. A file whose tests need a container does not belong
here.

## The threshold

`thresholds.break` is 95, against an actual score of 100. The gap is not slack
for letting the score drift: it is there because a run is not reproducible down
to the individual mutant. A mutant that hangs is counted as killed by a 5s
timeout, and a loaded CI runner can resolve a marginal one the other way. One
mutant is ~0.6% at this scope, so 95 is about eight mutants of tolerance —
enough that a busy runner cannot turn the job red on its own, and far too little
to absorb a deleted assertion.

One thing `break` does not catch: a `mutate` list that produces no mutants at
all scores `NaN`, and `NaN >= 95` is false in neither direction — Stryker logs
"greater than or equal to break threshold" and exits 0. Reached by emptying the
list, or by pointing it at a file that is only decorators
(`cursor-pagination.dto.ts` has zero mutants). That is what
`src/common/toolchain/mutation-scope.spec.ts` is for: it fails on an empty
scope, on a path that does not exist, and on a file with no spec beside it to
kill anything.

Raise it when the scope grows: more mutants make each one worth less, so the
same absolute tolerance buys a tighter percentage.

## No TypeScript checker

The usual pairing is `@stryker-mutator/typescript-checker`, which type-checks
each mutant so one that breaks the types is reported as a compile error and left
out of the denominator rather than counted. It requires
`disableTypeChecks: false`, and that does not work here — Stryker's
instrumentation preamble does not compile under this `tsconfig.json`
(`strict`, `noImplicitAny`), so the dry run fails before a single mutant is
created:

```
src/payments/money.ts:16:3 - error TS2630: Cannot assign to 'stryNS_9fa48' because it is a function.
```

With the default `disableTypeChecks` the sandbox copy gets a `// @ts-nocheck`
header — the repository's own files are never touched — and the checker would
have nothing left to check, so it is not installed. The cost is that a
type-invalid mutant is treated as an ordinary one. At this scope that is a
handful, and they are killed rather than survived, so the score it reports is if
anything generous.

## Running it

```bash
pnpm test:mutation                              # the configured scope
pnpm test:mutation --mutate src/orders/order.ts  # one file, ignoring the config
pnpm test:mutation --concurrency 2              # on a machine doing other work
```

A full run is around 4m30s on four workers. Stryker copies the repository into
`.stryker-tmp` once per worker; both that and `reports/` are gitignored.
