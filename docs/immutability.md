# Immutability

Three pieces that only work together: `readonly` types that stop a write at
compile time, a deep freeze that stops one at runtime while developing, and
update helpers that produce new values by sharing whatever did not change.

Everything lives in `src/common/immutable`.

## Why all three

The order they are usually adopted in is the wrong one. Structural sharing looks
like a pure optimisation — reuse the subtrees an update did not touch, allocate
less, and get a cheap "did anything change?" check out of it. But sharing
changes what a mutation _means_:

```ts
const prefs = await store.getPreferences(userId);
prefs.timezone = "Europe/Berlin"; // "my own copy"
```

Before sharing, that line corrupts one caller's value. After it, `prefs` may be
the object the store is still holding, or — for a user who has never set a
preference — `DEFAULT_USER_PREFERENCES` itself, shared by every such user in the
process. The same line now changes the defaults for everyone.

So freezing is not a nicety layered on top of sharing; it is the thing that makes
sharing safe to adopt at all. And because freezing has a cost, the type layer is
what carries the rule into production, where the freeze is off.

|                    | Stops                                             | Where          |
| ------------------ | ------------------------------------------------- | -------------- |
| `DeepReadonly<T>`  | a write the compiler can see                      | everywhere     |
| `deepFreeze`       | a write the compiler cannot see (`as`, `unknown`) | outside prod\* |
| Structural sharing | the copy that made a "safe" mutation feel safe    | everywhere     |

\* Except constants. `DEFAULT_USER_PREFERENCES` is frozen unconditionally: it is
one object frozen once at boot, and it is the single most shared value in the
system.

## `deepFreeze`

```ts
import { deepFreeze, isDeeplyFrozen } from "@/common/immutable";

const config = deepFreeze({ retries: 3, backoff: { initialMs: 100 } });
config.backoff.initialMs = 200; // TypeError
```

It freezes the value in place and returns it, typed `DeepReadonly<T>`.

Four things it does that a five-line recursive freeze does not, each pinned by
`deep-freeze.spec.ts`:

- **It skips values that cannot be frozen.** `Object.freeze` _throws_
  `TypeError: Cannot freeze array buffer views with elements` on any non-empty
  `Buffer` or typed array. A naive implementation does not degrade on binary
  payloads — it crashes on them.
- **It is cycle-safe.** A `WeakSet` of visited objects means `a.self = a`
  terminates instead of exhausting the stack.
- **It never invokes an accessor.** Traversal reads property _descriptors_ and
  descends only into `value` slots. Walking `Object.values()` would call every
  getter — running side effects, and propagating whatever a lazy getter throws —
  during what should be an inert walk.
- **It covers non-enumerable and symbol-keyed properties**, which are exactly as
  mutable as enumerable ones.

### What it cannot do

`Object.freeze` stops property writes. It does **not** stop:

```ts
const frozen = deepFreeze({ seen: new Set<string>(), at: new Date(0) });
frozen.seen.add("still works"); // no error
frozen.at.setUTCFullYear(2000); // no error
```

`Map`, `Set` and `Date` keep their state in internal slots, which no amount of
freezing reaches. That is why `DeepReadonly` maps them to `ReadonlyMap` and
`ReadonlySet`: for collections, **the type layer is the only layer doing the
work**. `isDeeplyFrozen` mirrors the same rules, so it never reports a violation
`deepFreeze` had no way to prevent.

### Why the runtime guard works at all

A write to a frozen property throws only in strict mode; in sloppy mode it is
silently discarded. This codebase sets `strict: true`, which implies
`alwaysStrict`, so every compiled module is strict and every such write throws.
That dependency is pinned by a test rather than assumed.

## Frozen request payloads

`DeepFreezePipe` is bound after `ValidationPipe` in `main.ts`, so it freezes the
DTO instance `class-transformer` produced rather than the plain body about to be
replaced. It is on outside production.

The bug it is aimed at is in-place normalisation:

```ts
async update(@Body() dto: UpdateUserDto) {
  dto.name = dto.name.trim(); // fine today
}
```

That works until the payload is read twice — an idempotent replay, a retry, a
value that turned out to be shared — at which point the second read sees input
the first one rewrote. Frozen, it throws on the line that does it.

It deliberately touches only parameters whose metatype is a user-defined class:

- `type: "custom"` (`@Req()`, `@Res()`, `@UploadedFile()`, `@CurrentUser()`) is
  skipped. Freezing an Express request or response would break the framework
  outright — both are mutated throughout the request lifecycle.
- A native metatype (`@Param("id") id: string`, an untyped `@Query()`) means the
  value is the raw `req.query`/`req.params` object Express built and may reuse.

It is off in production, where the traversal is cost against a guarantee the
types already give, and where turning a latent mutation into a thrown
`TypeError` would convert a subtly wrong response into a 500.

## Structural sharing

```ts
import { patch, setKey, updateKey, mapArray, removeKey } from "@/common/immutable";
```

Two guarantees, both about _reference identity_ rather than equality:

```ts
setKey(profile, "name", profile.name) === profile; // a no-op returns its input
setKey(profile, "name", "Joan").preferences === profile.preferences; // shared
```

The first turns "did this request change anything?" into a pointer comparison —
no deep walk, no dirty flag. The second makes the same comparison work one level
down, so a holder of the old value can tell which parts it still shares.

Nesting is expressed by composing `updateKey` rather than by a `setIn(obj,
["a","b"], value)` taking a path array. A path array cannot be typed against the
object it indexes without giving up either the key names or the value type, and
the no-op rule composes: if the innermost update changes nothing, every
enclosing one returns its own input too.

```ts
// Returns `user` itself when the theme is already "dark".
updateKey(user, "preferences", (p) => patch(p, { theme: "dark" }));
```

`patch` ignores keys whose value is `undefined`. This is policy, not defence: a
validated DTO instance has every optional field _present_, and all but the
supplied ones `undefined`, so a plain `{...current, ...dto}` blanks out five
settings to change one. `setKey` is the way to set a key _to_ `undefined`, where
saying so is the whole call.

### Frozen-ness is preserved, deliberately

Every helper returns a frozen value when given a frozen one. Without that rule
the guard would be conditional on the data: a no-op update returns the frozen
input and throws on a later write, while a real update returns a thawed copy and
accepts one — the same code path failing for only some inputs, which is worse
than no guard at all.

## Worked example: user preferences

`mergePreferences` is `patch`, and `DEFAULT_USER_PREFERENCES` is frozen at module
load. Those two facts together give a property neither store implements on
purpose, asserted in `users-store.contract.ts` for every implementation:

- Every user with nothing stored is handed **the same defaults object**.
- Every value derived from it is frozen too, because the helpers preserve
  frozen-ness — so the guarantee holds in production, where the pipe is off.
- Preferences leave the ports typed `ReadonlyUserPreferences`, because the value
  a store hands out may be one it is still holding.

`UserPreferences` itself stays a mutable type alias: only type aliases get an
implicit index signature, which is what makes it assignable to Prisma's
`InputJsonValue` on the write path. The readonly form turned out to satisfy that
too, so the boundary needs no copy — but the mutable alias remains the shape
that is _written_, and the readonly one the shape that is _read_.
