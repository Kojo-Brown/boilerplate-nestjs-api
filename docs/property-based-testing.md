# Property-based testing

An example test says what the function does for one input somebody chose. A
property test says what is true of the function for every input a generator can
reach, and then goes looking for one where it is not.

The difference matters most where the inputs come from outside the process. The
money helpers read amounts out of provider responses; the pagination helpers
read a cursor out of a query string. In both places the set of inputs an author
thinks of is small, tidy and unrepresentative, and the set that arrives is
neither.

Two suites exist today:

| Suite                                                      | Covers                                       |
| ---------------------------------------------------------- | -------------------------------------------- |
| `src/payments/money.property.spec.ts`                      | `src/payments/money.ts`                      |
| `src/common/pagination/build-cursor-page.property.spec.ts` | `src/common/pagination/build-cursor-page.ts` |

Both run inside `pnpm test`. They are ordinary Jest suites; fast-check is a
library, not a runner.

## What the first run found

Two defects, both in `money.ts`, both in code that was at 100% line coverage and
had survived a mutation run.

**`toDecimalString({ amountMinor: 1e21, currency: "EUR" })` returned
`"1e+.21"`.** `Number.isInteger(1e21)` is `true`, so the amount passed
validation. `String(1e21)` is `"1e+21"`, and the renderer — which pads and
slices a digit string precisely so that no float is ever involved — treated the
exponent as digits. The result was the `value` field of a PayPal capture
request.

**`fromDecimalString("99999999999999999999.99", "EUR")` returned `1e22` minor
units.** `Number()` of a twenty-two digit string is not that number, it is the
nearest double to it. The amount parsed, silently, as something the provider
never sent.

Both are the same defect from two directions: the module's integer arithmetic is
exact over the safe-integer range and nowhere else, and nothing said so.
`normaliseMoney` and `fromDecimalString` now reject amounts above
`Number.MAX_SAFE_INTEGER` with an `InvalidMoneyError` naming the limit — an
amount that cannot be represented is refused at the edge rather than rounded in
the middle. 2^53 − 1 minor units is about 90 trillion euros, so the range that
was given up is not a range anybody is charging.

## Writing one

A property is an invariant plus a generator. The invariant is the part worth
thinking about; a property that restates the implementation (`expect(f(x)).toBe(
x.toUpperCase() === y.toUpperCase())`) passes for the same reason the code
compiles and finds nothing. The ones in these suites are the four shapes that
tend to be worth stating:

- **Round-trip.** `fromDecimalString(toDecimalString(m), m.currency)` is `m`.
  Two functions that are supposed to be inverses, asked whether they are.
- **Invariant on the output.** Whatever `toDecimalString` returns is digits with
  the currency's own number of decimal places, and those digits are the minor
  units unchanged. `"1e+.21"` fails this one on sight.
- **Model.** Walking the pages of a list through `buildCursorPage`, following
  `nextCursor`, gives back that list — no row lost, repeated or reordered. The
  model is the list; the code under test is the paginator.
- **Totality.** For any string a client can send, `parseCursorArg` returns an
  argument or `undefined`, and never throws. For any amount or currency,
  `normaliseMoney` returns a valid `Money` or throws `InvalidMoneyError`, and
  never a `TypeError`. This is the property that catches a pure function
  exploding into a 500.

### Generate what the code accepts, not what it should accept

The subtlest way to write a property that cannot fail is to bound the generator
by the fix. An arbitrary of `fc.maxSafeNat()` never produces `1e21`, so a
round-trip property over it would have been green against the broken renderer —
the bug lives exactly in the gap between what the validation accepted and what
the generator explored.

So the amount arbitrary covers every non-negative value `Number.isInteger` is
true of, and the property is stated conditionally: _whatever `normaliseMoney`
accepts must round-trip_. Refusing an input satisfies it; rendering one that
cannot be read back does not. That phrasing survives the fix instead of being
retired by it.

### Check that the property can fail

A property test that has never been seen red is a guess. Both suites were run
against deliberately broken code before being committed:

- the two `money.ts` guards removed — four properties fail, shrinking to
  `1e+21` and `9007199254740992`;
- `nextCursor` taken from `items[0]` instead of the last item — three fail;
- `hasNextPage` computed with `>=` — two fail;
- the page sliced one row short — three fail.

`fc.assert` shrinks a counterexample to the smallest input that still fails,
which is why the reported values above are the boundaries themselves rather than
whatever random monster first tripped the property.

## Seeds, and why they are fixed

fast-check seeds itself from `Date.now()` by default. That makes every run a
different experiment — and a failing run one that nobody can reproduce,
including the next CI attempt on the same commit. It also sits badly with the
mutation gate: a property that catches a mutant four runs in five turns a
`break` threshold into a coin toss.

`src/test-utils/fast-check.ts` therefore pins the seed and the run count
(`configureFastCheck()`, called at the top of each property suite). The
exploration happens deliberately rather than at 3am:

```bash
# A different corner of the input space, 50x the cases.
FAST_CHECK_SEED=20260815 FAST_CHECK_RUNS=10000 pnpm test -- money.property

# A soak: twenty seeds, stopping at the first failure.
for seed in $(seq 1 20); do FAST_CHECK_SEED=$seed pnpm test -- property || break; done
```

Worth doing after changing either helper, or either suite. A seed that is not a
positive integer fails loudly rather than falling back to the default, because a
typo'd soak that silently re-runs the committed seed looks exactly like a soak
that found nothing.

## Relationship to the other suites

- **Example tests** stay. They are the readable statement of what the function
  does, and a property that fails is usually pinned afterwards as an example —
  both bugs above now have one in `money.spec.ts`. A property says _always_; an
  example says _this_, and a reader needs both.
- **Mutation testing** (`docs/mutation-testing.md`) asks whether the suite would
  notice the code being wrong. It found eight unasserted behaviours in these two
  files and did not find either of the bugs here, because a mutant is a small
  edit to existing code and neither bug is reachable that way — nothing in
  `money.ts` had to change for `1e21` to render as `"1e+.21"`. The two techniques
  fail in different directions, which is the argument for running both.

## Adding a suite

1. Put it beside the code as `<name>.property.spec.ts`. `testRegex` picks it up.
2. Call `configureFastCheck()` at the top of the file.
3. Write the generators first, and weight them: three zero-decimal currencies out
   of 17,576 possible codes will otherwise never be drawn, and every interesting
   branch in `money.ts` is on that path.
4. Break the code and watch the property fail before committing it.
5. If the file is pure domain logic, add it to `mutate` in `stryker.config.mjs`
   too. The two gates answer different questions.
