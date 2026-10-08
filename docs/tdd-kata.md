# TDD kata — a basket is a set of products

A worked red→green→refactor cycle on a real defect in this repository, one
commit per step. The three commits are on the branch that introduced this file
and are meant to be read in order:

| Step         | Commit                                                             | State of `pnpm test`         |
| ------------ | ------------------------------------------------------------------ | ---------------------------- |
| 1 — red      | `test: red — a basket is a set of products, and repeating a SKU …` | **14 failing**, 74 passing\* |
| 2 — green    | `feat: green — one basket, merged once, bounded per SKU`           | 3071 passing                 |
| 3 — refactor | `refactor: one merge in the tree, one catalogue read per line, …`  | 3071 passing                 |

\* counted over `src/orders`, which is the 11 suites the cycle touches. Across
the whole suite the red commit is 196 suites with 14 failures in 3 of them.

The point of writing it down is not the feature. It is that each step had a
different job, and that the jobs are easy to blur: a red step that also
implements, a green step that also tidies, a refactor step that also changes
behaviour and tells itself the tests still passing means nothing broke. Keeping
them apart is what makes the third commit cheap to review — its production
code changes 38 non-comment lines across five files, and the assertions around
them are byte-identical to the ones written in step 1.

---

## The defect

Nothing about this was hypothetical. On `main`, a checkout request's lines
reached **three separate records of the same basket by three different routes**,
and the three could disagree:

```
POST /v1/orders  { items: [ LAMP x1, DESK x1, LAMP x2 ] }
        │
        ├── priceOrder()                    →  order row + API response + order.placed
        │      one item per *line*             LAMP x1, DESK x1, LAMP x2      (3 lines)
        │
        ├── PlaceOrderHandler                →  checkout saga state
        │      input.lines, copied verbatim     LAMP x1, DESK x1, LAMP x2      (3 lines)
        │      …which create-shipment ships from
        │
        └── InMemoryInventoryService.reserve →  the warehouse hold
               merges repeats before            LAMP x3, DESK x1               (2 lines)
               checking stock
```

The warehouse was right, and had been right on purpose — its `reserve` merges
first, with a comment explaining the oversell it is avoiding, because checking
`LAMP x7` and `LAMP x7` separately compares each against the whole shelf and
passes a request for twice what is there. But nothing upstream did the same, so
the hold described a basket that the order row, the API response, the encrypted
`items` column and the shipment did not. `order.placed` reported a `lineCount`
of 3 for a two-product order.

And the per-SKU bound did not survive the gap. `CreateOrderItemDto` caps a line
at 100 units and said so in a comment:

```ts
// An upper bound per line as well as per order: without one, a single line of
// 10^9 units is a reservation request no warehouse should be asked to price.
@Max(100)
```

"as well as per order" was not true. `class-validator` hands `@Max` one array
element at a time and gives it no way to notice that the element beside it names
the same SKU, so with `@ArrayMaxSize(20)` above it, twenty valid lines are an
accepted order for **two thousand** units of one product. The request path never
refused it. The warehouse did, three steps into the saga, and only when the
shelf happened to be the binding constraint — which for a cheap, well-stocked
SKU it is not.

A per-element validator cannot express "at most 100 of any one product",
because that is a property of the basket rather than of a line. Which is the
whole shape of the fix: canonicalise the basket once, before anything reads it.

---

## Step 1 — red

> **Job:** state the behaviour, and watch the statement fail. Nothing else.

`src/orders/basket.spec.ts` was written first, 15 cases over two functions that
did not exist yet, plus 7 more at the two call sites (`catalogue.spec.ts`,
`write/place-order.command.spec.ts`) — 22 new cases in all.

The one decision worth arguing about is what the production file contains at
this commit. In a typed language the options are not equivalent:

- **Nothing at all.** `basket.spec.ts` fails to compile, Jest reports one
  "Cannot find module" per suite, and `pnpm typecheck` fails too. That is red,
  but it is red the way a typo is red: one message about the import, and no
  information about which behaviours are missing.
- **A body that throws `not implemented`.** Every case fails with the same
  error, so the run says "15 things are missing" and nothing about what they
  are. The cases that should already pass fail too, which hides them.
- **Today's behaviour, written down.** `mergeLines` and `canonicaliseBasket`
  return their input untouched — which is literally what `priceOrder` did —
  under a `// RED STEP` comment.

The third is what this kata uses, and the reason is in the output. The run names
the missing behaviours one at a time, and the eight of the 22 new cases that
pass are exactly the ones that should: a basket with no repeats is already canonical, merging is
already idempotent on one, nothing is already mutated.

```
 PASS  src/orders/services/in-memory-inventory.service.spec.ts
 FAIL  src/orders/basket.spec.ts
 FAIL  src/orders/catalogue.spec.ts
 FAIL  src/orders/write/place-order.command.spec.ts

  mergeLines
    ✓ leaves a basket with no repeats exactly as it is
    ✕ sums two lines of the same SKU into one
    ✕ keeps the order the customer built the basket in
    ✓ changes nothing on a basket it has already merged
    ✕ conserves the quantity of every SKU
    ✕ names every SKU exactly once
    ✓ merges an empty basket to an empty basket
    ✓ does not mutate the basket it was given
  canonicaliseBasket
    ✕ merges repeats, like mergeLines
    ✓ allows a SKU right up to the bound
    ✕ refuses a SKU one over the bound
    ✕ refuses the bound being defeated by repeating the SKU
    ✓ judges each SKU on its own merged quantity
    ✕ refuses as caller input, so the request path answers 400
    ✓ names the SKU and the quantity it refused
  priceOrder
    ✕ prices a repeated SKU as one line of the summed quantity
    ✕ charges the same for a basket however it was built up
    ✕ refuses a basket whose merged quantity passes the per-SKU bound
    ✓ checks the SKU exists before it checks the quantity
  PlaceOrderHandler
    ✕ writes one basket, not three descriptions of one
    ✕ reports the number of products in order.placed, not the number of lines sent
    ✕ refuses a basket over the per-SKU bound before anything is written

Test Suites: 3 failed, 8 passed, 11 total
Tests:       14 failed, 74 passed, 88 total
```

`pnpm typecheck`, `pnpm lint` and `pnpm format:check` all pass on this commit.
A red commit should be red in exactly one way.

The failure that is worth the whole exercise is the third from last, because it
is a picture of the defect rather than of a missing function:

```
  ● PlaceOrderHandler › writes one basket, not three descriptions of one

    - Expected  - 1
    + Received  + 6

      Array [
        Object {
    -     "quantity": 3,
    +     "quantity": 1,
          "sku": "SKU-LAMP-03",
          "unitPriceMinor": 4250,
        },
        Object {
          "quantity": 1,
          "sku": "SKU-DESK-01",
          "unitPriceMinor": 34900,
    +   },
    +   Object {
    +     "quantity": 2,
    +     "sku": "SKU-LAMP-03",
    +     "unitPriceMinor": 4250,
        },
      ]
```

That is an order, as it would have been stored, charged for and answered with:
one product on two lines, three lines in a two-product basket.

### What the specs pin, and why those

Picking the cases is most of the work, and a few of them are there for reasons
that are not obvious:

- **"conserves the quantity of every SKU"** asserts the sum of quantities is
  unchanged, separately from asserting the resulting array. A merge that dropped
  a line would satisfy a looser "has one line per SKU" test and would be a
  silent discount. This is the invariant; the array assertion beside it is the
  example.
- **"keeps the order the customer built the basket in"** exists because
  first-appearance ordering is a property of `Map` iteration rather than of
  anything the loop does deliberately. Unpinned, it would survive until somebody
  swapped the collection, and then every order's lines would come back in a
  different order for no reason anybody asked for.
- **"changes nothing on a basket it has already merged"** is idempotence, and it
  is load-bearing: it is what lets the warehouse adapter keep merging
  defensively after step 3 without caring whether its caller already did.
- **"allows a SKU right up to the bound"** and **"refuses a SKU one over the
  bound"** are the two sides of a boundary. A single "refuses 200" would pass
  against `>= 100`, `> 99` and `> 0` alike.
- **"refuses as caller input, so the request path answers 400"** asserts the
  _type_ of the refusal, not just that it happens. A plain `Error` here is a 500
  for a request the caller can fix, and `AllExceptionsFilter` would have nothing
  better to say about it.
- **"checks the SKU exists before it checks the quantity"** pins an ordering
  between two 400s. Both are correct answers, so this is a choice rather than a
  discovery — `UnknownSkuError` is the more useful one for a line that is both —
  and a choice nobody wrote down is a choice the next refactor reverses for
  free. It is also the spec that passed in red and constrained the green
  implementation, which is the useful kind of spec to have written early.
- **"judges each SKU on its own merged quantity"** is a negative control: two
  different SKUs at the bound is a large order, not an invalid one. Without it,
  an implementation that capped the _basket_ would pass everything else here.

## Step 2 — green

> **Job:** make the statement true. Not elegant — true.

`mergeLines` became a `Map<string, number>` loop, `canonicaliseBasket` became
that plus a bound check, `priceOrder` called it, and `PlaceOrderHandler` started
taking the saga state's lines from the priced basket instead of from the
request. All 88 specs under `src/orders` passed, and the whole suite went from
3049 passing to 3071 passing with nothing newly failing.

One spec written in step 1 pushed back on the obvious implementation, which is
the point of having written it first. "Checks the SKU exists before it checks
the quantity" rules out the tidy-looking

```ts
const items = canonicaliseBasket(lines).map(/* look up the price */);
```

because `canonicaliseBasket` would then refuse `SKU-IMAGINARY x101` for its
quantity and never get as far as noticing nobody sells it. The green version
therefore checked existence first, over the raw lines, and looked the catalogue
up again afterwards to price the merged ones.

That is a worse `priceOrder` than the one it replaced: two reads per line and a
guard the compiler demanded but execution can never reach.

```ts
const items = canonicaliseBasket(lines).map((line) => {
  const entry = PRODUCT_CATALOGUE[line.sku];
  // Unreachable: every SKU was checked against this same record above. The
  // guard is here because `noUncheckedIndexedAccess` cannot know that.
  if (!entry) throw new UnknownSkuError(line.sku);
  …
});
```

It was committed anyway, with that comment and a commit message naming it and
the duplicated merge loop as work for step 3. A green step that stops to be
elegant is a green step whose diff mixes "this is why the tests pass" with "this
is to taste", and a reviewer can no longer tell which line is which.

## Step 3 — refactor

> **Job:** change the design, change no behaviour, and let the step-1 specs be
> the thing that says so.

Four changes, 38 non-comment lines of production code, and the assertions from
step 1 are byte-identical:

1. **`mergeLines` is generic** in `<T extends ReservedLine>`, keeping whatever
   else a line carries from its first appearance. That lets `priceOrder` price
   the raw lines once — `UnknownSkuError` still first, still naming the caller's
   first mistake — and merge the _priced_ items afterwards. One catalogue read
   per line, and the unreachable guard is gone with the second read that needed
   it.
2. **One merge in the tree.** `InMemoryInventoryService` had its own copy of the
   loop, three lines that had to agree with the domain's for the hold and the
   row to describe the same basket, with nothing but a comment saying so. It now
   calls `mergeLines`. The _call_ stays — see below.
3. **One bound.** `CreateOrderItemDto` carried the literal `100` twice, in
   `@Max` and in the Swagger `maximum`. Both read `MAX_QUANTITY_PER_SKU` now,
   and the comment that claimed the line bound was also an order bound says
   instead what the validator can and cannot see.
4. **The module's surface.** The four new names are exported from
   `src/orders/index.ts` like everything else in the module.

### Why the warehouse still merges

After step 2 the adapter's merge is dead code in this application: every
checkout reaches it through `priceOrder`, which has already canonicalised.
Deleting it would have been the smaller diff and would have kept every test
green.

It stays because the **port** promises nothing about its input. `InventoryService`
is an interface whose shipped implementation happens to be in-process; in a
deployment it is somebody else's warehouse behind HTTP, and the next caller is
not necessarily this `priceOrder`. A warehouse that trusts its callers to
deduplicate is a warehouse that oversells for a reason nobody can see in a diff
— and the merge is idempotent, so the second pass costs one walk over at most
twenty lines. That is the trade stated out loud rather than a comment saying
"defensive".

Which is also why idempotence got its own spec in step 1, before there was any
intention to call `mergeLines` twice.

### Two test changes, neither a weakening

A refactor commit that touches specs deserves suspicion, so both are itemised:

- **Added** one case, "keeps whatever else a line carries, from its first
  appearance". It pins the generic signature's contract, which did not exist to
  pin before this commit.
- **Removed** `describe("mergeLines")` from
  `in-memory-inventory.service.spec.ts` — one case asserting the helper's merge,
  in the file the helper used to live in. `basket.spec.ts` now covers that
  property on a strict superset of inputs, and the adapter's own obligation is
  still asserted through its public API by "counts two lines of the same SKU as
  one quantity", which is the stronger test and stays.

Net: 3071 passing before the commit, 3071 after.

---

## What the cycle produced

`src/orders/basket.ts`, 100% covered:

```ts
export const MAX_QUANTITY_PER_SKU = 100;

export class LineQuantityExceededError extends BadRequestException { … }

/** Sums repeated SKUs. Conserves every quantity, caps nothing, idempotent. */
export function mergeLines<T extends ReservedLine>(lines: readonly T[]): readonly T[];

/** `mergeLines`, plus the bound that is only checkable once they are merged. */
export function canonicaliseBasket<T extends ReservedLine>(lines: readonly T[]): readonly T[];
```

and one basket where there were three:

```
POST /v1/orders  { items: [ LAMP x1, DESK x1, LAMP x2 ] }
        │
        └── priceOrder()  ─ canonicaliseBasket ─→  LAMP x3, DESK x1
                 │
                 ├──→ order row, API response, encrypted items, order.placed (lineCount 2)
                 ├──→ checkout saga state ──→ create-shipment
                 └──→ reserve-stock ──→ the warehouse hold
```

`POST /v1/orders` with `LAMP x100` twice is now `400` —
`Order is for 200 of "SKU-LAMP-03", more than the 100 allowed per SKU` — instead
of an accepted order for twice what an order may be for.

## Doing one of these

1. **Write the test against the behaviour, not the implementation.** Every case
   above names something a reader of the API would care about. None of them
   mentions a `Map`.
2. **Make red informative.** In a typed language that usually means the
   production file exists with real signatures and a body that is honestly
   wrong, so the suite reports which behaviours are missing rather than one
   compile error. Check `typecheck`, `lint` and `format` pass on the red commit:
   it should be red in exactly one way.
3. **Include the cases that should already pass.** They are what tells you the
   suite is measuring the right thing, and in step 1 above they are also what
   proved the defect was about repeats specifically.
4. **Pin the invariant, not only the example.** "Conserves every quantity" and
   "names every SKU exactly once" are properties; the `toEqual` beside them is
   an illustration. (The property-based version of exactly this is the next
   `SPEC.md` item.)
5. **Let green be ugly, and say where.** Name the smells in the commit message.
   They are the agenda for step 3, and writing them down is what stops the green
   diff from mixing correctness with taste.
6. **Change no assertion in the refactor.** If one has to change, it is not a
   refactor — and if one does change, itemise it, because "the tests still pass"
   is worth nothing when the tests moved too.
