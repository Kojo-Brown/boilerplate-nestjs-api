# Method aspects — `@Cacheable()`, `@Retry()`, `@Timed()`

Three decorators that add a cross-cutting concern to a provider method without
that method knowing about it:

| Decorator      | Adds                                                      |
| -------------- | --------------------------------------------------------- |
| `@Cacheable()` | Memoises the resolved value in the application cache      |
| `@Retry()`     | Re-runs transient failures under a jittered backoff       |
| `@Timed()`     | Reports the call's duration and outcome to a metrics sink |

```ts
import { Cacheable, Retry, Timed } from "@/common/aspects";

@Injectable()
export class ExchangeRatesService {
  @Timed({ name: "rates.fetch", slowerThanMs: 500 })
  @Cacheable({ ttlMs: 60_000, keyPrefix: "rates" })
  @Retry({ attempts: 4, delayMs: 200 })
  async fetch(base: string): Promise<Rates> {
    return this.http.get(`/rates?base=${base}`);
  }
}
```

Everything below is the reasoning behind the parts that are not obvious.

---

## How they work: metadata now, behaviour later

The decorators wrap nothing. Each one validates its options and writes them to
`Reflect.defineMetadata` against the prototype and method name; that is the
whole implementation.

They have to. A decorator runs while the class body is being evaluated — at
import time, before `NestFactory.create()` has been called, let alone before any
provider exists. `@Cacheable()` needs a cache, `@Retry()` needs a clock. Neither
is available at the moment the decorator runs, and reaching for a module-level
singleton to work around that would put a piece of global mutable state under
every decorated method in the app.

`AspectWeaver` closes the gap. On `onModuleInit` it walks the container with
`DiscoveryService`, reads the metadata back, and replaces each decorated method
with a chain that closes over the injected cache, clock, random source and
recorder. Options are validated in the decorator rather than in the weaver, so
`@Retry({ attempts: 0 })` fails at import time instead of on the first outage.

`Reflect.getMetadata` walks the prototype chain, so a subclass inherits the
aspects of a method it overrides. That is intended: an override is expected to
honour the contract of what it replaces, and silently dropping the retry policy
would be a surprising way to break it.

---

## Where they apply, and where they do not

**Singleton providers only.** The weaver reports anything else at `warn` and
moves on, because a cross-cutting concern that quietly does not apply is worse
than one that is absent.

| Target                                       | Effect  | Why                                                                                                                        |
| -------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@Injectable()` (default scope)              | Woven   | One instance, created before `onModuleInit`                                                                                |
| `@Controller()` handler                      | Skipped | `NestApplication.init()` runs `registerRouter()` before `callInitHook()`, so the router already holds the original handler |
| `REQUEST` / `TRANSIENT` provider             | Skipped | The instance a consumer receives is cloned per request or per injection, after weaving                                     |
| A provider depending on a request-scoped one | Skipped | Nest propagates request scope up the dependency tree (`isDependencyTreeStatic()`)                                          |

For a controller, move the work into a provider and let the handler delegate to
it. For HTTP response caching specifically, `HttpCacheInterceptor` in
`src/common/cache` already exists and runs in the right place.

Weaving replaces the method as an own property of the instance rather than on
the prototype, so two Nest applications in one process (an e2e suite, say) never
share a wrapper. Re-weaving is a no-op: every installed wrapper is marked, and
the wrapper keeps the original's `name` and `length` so stack traces and arity
checks read the same as before.

---

## Composition order

Stacking order in the source does not matter. The weaver always builds:

```
@Timed  →  @Cacheable  →  @Retry  →  your method
```

Which gives:

- **a cache hit costs no retries** — it never reaches the retry layer at all;
- **a call that only succeeds on its third attempt is cached once**, as a
  success, with no trace of the two failures;
- **the recorded duration is what the caller actually waited** — cache lookup,
  every attempt, and every backoff sleep included. A p99 that excluded the
  backoff would describe a latency nobody experienced.

Fixing the order here rather than reading it off the decorator stack means
nobody has to remember that decorators apply bottom-up to know what they get.

---

## `@Cacheable()`

```ts
@Cacheable({ ttlMs: 30_000, keyPrefix: "users" })
async findById(id: string): Promise<User | null> { ... }
```

| Option      | Default           | Notes                                       |
| ----------- | ----------------- | ------------------------------------------- |
| `ttlMs`     | the store's own   | Milliseconds                                |
| `keyPrefix` | none              | Namespace, e.g. for bulk invalidation       |
| `key`       | derived from args | `(args) => string`, for unkeyable arguments |

Entries go through `CacheService`, so they share the Redis instance (or the
in-process store when `REDIS_URL` is unset) that `AppCacheModule` configures.

**Keys** are `prefix:Class.method:[args]`, with the arguments serialised by
`stableStringify`. Object keys are sorted at every level, so `{ role, limit }`
and `{ limit, role }` — the same call — hit the same entry. Values JSON cannot
round-trip unambiguously are refused rather than coerced: `undefined` vanishing
from an object, or a `Date` colliding with its own ISO string, would be two
different calls sharing a key, which is the one failure mode a cache must never
have. Pass `key` when an argument is a callback, a `Map`, or a buffer.

**A cache never changes the outcome of a call.** An unkeyable argument list, an
unreachable Redis, a failed write — each degrades to calling straight through,
logging the first occurrence at `warn` and the rest at `debug`.

**Cached `undefined` is a hit, not a miss.** Values are boxed on the way in,
because `store.get()` answers `undefined` for both and a method that
legitimately resolves to `undefined` would otherwise re-run on every call while
still paying for the lookup.

**Rejections are never cached.** Otherwise one upstream blip becomes a
`ttlMs`-long outage for every caller.

**Concurrent misses for one key collapse into a single call.** Without that, N
simultaneous misses are N queries — the stampede a cold cache or an expiring hot
entry produces exactly when the system can least absorb it.

**Invalidation is yours.** Hold the `keyPrefix` and delete through
`CacheService` when the underlying data changes. Nothing here watches writes.

## `@Retry()`

```ts
@Retry({ attempts: 4, delayMs: 200, maxDelayMs: 5_000 })
async capture(paymentId: string): Promise<Payment> { ... }
```

| Option       | Default            | Notes                                         |
| ------------ | ------------------ | --------------------------------------------- |
| `attempts`   | `3`                | Total, first included. `1` disables retrying  |
| `delayMs`    | `100`              | Base delay before the second attempt          |
| `maxDelayMs` | `2000`             | Ceiling, applied before jitter                |
| `backoff`    | `"exponential"`    | Or `"fixed"`                                  |
| `factor`     | `2`                | Multiplier per attempt                        |
| `jitter`     | `true`             | Full jitter: a uniform draw over `[0, delay)` |
| `retryIf`    | `isTransientError` | `(error, attempt) => boolean`                 |

**The method must be idempotent.** Nothing here can tell whether the attempt
that appeared to fail actually reached the other side.

**Not every failure is worth retrying.** The default policy retries anything
except a 4xx `HttpException` other than 408 and 429: a 400 or a 404 is the
caller being wrong, and retrying it only delays the same error by the whole
backoff schedule. Everything unrecognised — a socket hang-up, a Prisma error —
counts as transient, because the alternative is a whitelist that silently stops
retrying whatever it has not heard of.

**Jitter is on by default.** Backing off without it lines every caller that
failed at the same moment up to retry at the same moment, turning one blip into
a repeating thundering herd. Spreading the retries out is worth more than
honouring the nominal delay.

## `@Timed()`

```ts
@Timed({ name: "users.list", slowerThanMs: 250 })
async list(query: ListUsersQuery): Promise<Page<User>> { ... }
```

Samples go to the `METHOD_TIMING_RECORDER` port on both the success and the
failure path, and never change what the method returns. This is the one aspect
that accepts synchronous methods — it is how you find out whether a method is
worth making asynchronous in the first place.

The default recorder writes one structured line per call, at `debug` normally
and at `warn` for a failure or a call over `slowerThanMs`. It is deliberately
not a metrics client: this repo ships no Prometheus or OTel dependency, and
choosing one for everybody would be the wrong call to make in a boilerplate.
Point the token at yours:

```ts
@Module({
  providers: [{ provide: METHOD_TIMING_RECORDER, useClass: PrometheusTimingRecorder }],
  exports: [METHOD_TIMING_RECORDER],
})
export class MetricsModule {}
```

A recorder that throws is logged and swallowed. Observability is never worth
failing a call over.

---

## Type safety

`@Cacheable()` and `@Retry()` only compile on a method that returns a promise.
Both have to `await` — a cache cannot be read synchronously and a retry has to
wait between attempts — so applying them to a synchronous method would silently
start returning a promise to callers expecting a value:

```ts
@Cacheable()
countActive(): number { ... }
//           ^ Type '() => number' does not satisfy the constraint
//             '(...args: never[]) => Promise<unknown>'
```

The same case reaching the runtime from JavaScript, or through a cast, throws
`AspectUsageError` — and is not retried, since a misapplied decorator fails
identically on every attempt. `@Timed()` accepts either kind of method.

---

## Testing

Time and randomness are injected, so nothing in the suite sleeps:

```ts
const clock = new FakeAspectClock();     // records sleeps, resolves immediately
const cache = new InMemoryAspectCache(); // can be told to fail reads or writes

const moduleRef = await Test.createTestingModule({ ... })
  .overrideProvider(ASPECT_CLOCK).useValue(clock)
  .overrideProvider(ASPECT_CACHE).useValue(cache)
  .compile();

await moduleRef.init(); // weaving happens in onModuleInit — without this, nothing is wrapped
```

`AspectWeaver.weave()` returns a report of what it wrapped and what it refused,
which is what the suite asserts the controller and request-scope warnings
against.
