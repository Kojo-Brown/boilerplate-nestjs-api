# Provider scopes — and the request-scoped trap

Every provider in this application is a singleton unless something makes it
otherwise. That is the right default, and the interesting question is not
"which scope should this provider have" — it is "what happens to everything
else when one provider stops being a singleton".

| Scope       | Instances                        | Built when          | Lives until          |
| ----------- | -------------------------------- | ------------------- | -------------------- |
| `DEFAULT`   | one per application              | `app.init()`        | the process exits    |
| `REQUEST`   | one per request                  | the request arrives | the response is sent |
| `TRANSIENT` | one per injection site, per host | its host is built   | its host is released |

`src/di-scopes` has one of each, wired into the app and reachable at
`GET /v1/di-scopes`. Call it twice:

```bash
curl -s localhost:4000/v1/di-scopes | jq '.data | {singleton, requestScoped, transient}'
```

`singleton.instanceId` is the same on both calls, `requestScoped.instanceId` is
not, and `transient` depends on whose it is.

| File                               | Scope                | Point                                                   |
| ---------------------------------- | -------------------- | ------------------------------------------------------- |
| `feature-flag-cache.service.ts`    | `DEFAULT`            | a singleton whose usefulness _is_ its lifetime          |
| `request-context.service.ts`       | `REQUEST`            | per-request state, safe by construction                 |
| `scoped-logger.service.ts`         | `TRANSIENT`          | a logger that knows its host, via `INQUIRER`            |
| `audit-trail.service.ts`           | `DEFAULT`, inherited | **the trap**: request-scoped without saying so          |
| `singleton-audit-trail.service.ts` | `DEFAULT`            | the same class, fixed, by taking an argument            |
| `request-context.resolver.ts`      | `DEFAULT`            | reaching a request-scoped provider without becoming one |
| `scope-audit.service.ts`           | `DEFAULT`            | reports at boot what the container rebuilds per request |

---

## Scope propagates upwards, and says nothing

A provider is request-scoped if **anything in its dependency tree is**. Not just
its own declaration — any dependency, at any depth. So this:

```ts
@Injectable()
export class AuditTrailService {
  private readonly buffer: AuditEntry[] = [];

  constructor(private readonly context: RequestContextService) {} // ← Scope.REQUEST
}
```

is a request-scoped provider. Nothing in the file says so. Its author wrote an
accumulate-then-flush buffer, which is what you write when you expect one
instance to see everything the process does; it sees one request's entries and
is discarded with them. Every consumer of `AuditTrailService` is now
request-scoped too, and every consumer of _those_, up to and including the
controller.

The blast radius is the whole subtree above the change:

```
DiScopesController          ← rebuilt per request
└── AuditTrailService       ← rebuilt per request
    └── RequestContextService   Scope.REQUEST — the only file that asked for it
```

Nest does not warn. The application boots, every endpoint answers, and every
unit test passes — a test that constructs one instance and makes one call cannot
tell a singleton from a per-request instance. This is asserted end to end in
`src/di-scopes/scope-lifetimes.spec.ts`: three requests, three entries, and no
instance ever saw more than one.

## What it actually costs

Two different costs, and the smaller one gets all the attention.

### The instantiation cost is real and usually irrelevant

`pnpm bench:scopes` builds two applications with the same five-deep chain,
differing only in `Scope.REQUEST` on the leaf, and measures both.

```
┌───────────────────────┬───────────────────┬─────────────────┬─────────────────┬───────┐
│ chain                 │ constructions/req │ resolution (µs) │ end to end (ms) │ req/s │
├───────────────────────┼───────────────────┼─────────────────┼─────────────────┼───────┤
│ 'all singletons'      │ 0                 │ 0.5             │ 0.377           │ 2656  │
│ 'request-scoped leaf' │ 5                 │ 35.6            │ 0.483           │ 2072  │
└───────────────────────┴───────────────────┴─────────────────┴─────────────────┴───────┘
Node v22.22.2 on linux/x64 — 3000 requests and 20000 resolutions per trial, 5 trials, median
```

Producing the controller for one request goes from **0.5 µs to ~36 µs**, around
**70×**. End to end, against a handler that does nothing at all, that was 11–22%
fewer requests per second across runs on the machine this was written on.

Read the second number carefully before quoting it. 35 µs is what request scope
adds to a request; a handler that awaits one Postgres round trip has already
spent a hundred times that, so on a real endpoint the same change is
unmeasurable. **Request scope is not slow.** Rewriting a service to avoid 35 µs
is a bad trade, and a document that stopped here would have taught the wrong
lesson.

### The cost that matters is the state you stop keeping

A singleton is where memoised work lives. `FeatureFlagCache` parses its flag
table once and memoises each `flag:subject` evaluation; the second request to
ask the same question gets an answer for free. Inherit request scope and both
disappear:

- The parse moves onto every request's latency budget.
- The memo starts empty on every request, so it never returns a hit for a real
  client. It is now pure overhead — a cache **colder** than no cache, still
  paying to fill itself, never paying back.

The same reasoning applies to anything a singleton holds because holding it is
the point: a connection pool, a compiled schema, a rate-limiter's counters, a
warm HTTP agent, an in-process LRU. None of them are cheaper per request. They
are cheap _because_ there is one of them, and inheriting request scope is how a
codebase loses that without a diff that looks like it did.

That is why the first symptom is rarely "the service got slower on the deploy
that changed it". It is a cache hit rate that went to zero, or a p99 that grew
one release later, in a service whose own file has not changed in months.

### Two things request scope takes away outright

Both are pinned by `src/di-scopes/scope-caveats.spec.ts`, so a Nest upgrade that
changes either fails a test rather than making this section wrong.

**Lifecycle hooks never run.** `onModuleInit`, `onApplicationBootstrap` and
`onModuleDestroy` are not called on a request-scoped provider — not at boot, and
not per request. Anything a provider would normally do in `onModuleInit` — open
a client, warm a cache, register a listener — has to move into the constructor,
where it runs on the request's latency budget, every request.

**A global enhancer costs every route.** A request-scoped provider registered
with `APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE` or `APP_FILTER` applies to the
whole application, so it is rebuilt for every request to _every_ endpoint,
including the ones that inject nothing. This is the one case where the
instantiation cost above is worth caring about, because it is multiplied by
your entire route table.

Aspects are a third: `@Cacheable()`, `@Retry()` and `@Timed()` cannot be woven
into a request- or transient-scoped provider, because `AspectWeaver` runs at
`onModuleInit` and those instances do not exist yet. It reports each one it had
to skip — see [aspects.md](./aspects.md).

---

## Doing it without the scope

### 1. Pass the value as an argument

The first thing to try, and it resolves most cases. Whoever wants something
audited is nearly always closer to the request than the thing doing the
auditing, so it already has the correlation id or can be handed it.

```ts
// Before: request-scoped, and so is everything above it.
this.audit.record("users.update");

// After: a singleton, forever.
this.audit.record("users.update", correlationId);
```

`SingletonAuditTrail` is `AuditTrailService` with exactly that change. It costs
one parameter at each call site and keeps one instance for the process — so the
buffer accumulates as intended, and it can be injected into a guard, an
interceptor or a scheduled job, none of which have a request.

One thing comes with the longer lifetime: **bound the buffer**. An unbounded
array on a request-scoped provider is freed with its request; the same array on
a singleton grows until the pod is evicted. `AUDIT_BUFFER_LIMIT` is that bound.

### 2. Resolve through `ModuleRef` and the request's context id

For the case argument-passing cannot reach — a global interceptor, an exception
filter, a singleton several layers below anything holding the request.

```ts
const contextId = ContextIdFactory.getByRequest(request);
const context = await this.moduleRef.resolve(RequestContextService, contextId, { strict: false });
```

`ModuleRef` is a singleton, so nothing inherits a scope. The context id does the
work: Nest attaches one to every incoming request and keys request-scoped
instances by it, so this returns **the instance that request is already using**,
not a second one carrying the same data. `RequestContextResolver` wraps it, and
`test/di-scopes.e2e-spec.ts` asserts the identity over a real router — the only
place it can be asserted, since the id comes from the router.

Two costs, both real:

- `resolve()` is async, so a synchronous caller cannot use it.
- It is a service locator. The dependency is resolved by token at the call site
  rather than declared in a constructor, so it is invisible to the container's
  static graph and a missing provider becomes a runtime failure instead of a
  boot-time one.

Off the router — a BullMQ consumer, a cron tick — there is no attached id, and
`getByRequest` mints a fresh one on every call. The resolver keeps its own
`WeakMap` of carrier → context id and calls `registerRequestByContextId`, so a
job that resolves twice gets one context instead of two unbound ones.

### 3. `AsyncLocalStorage`, when the value is ambient

Not used in this repository, and worth knowing about. A correlation id that
every layer wants and no layer should have to declare is exactly what
`AsyncLocalStorage` is for: the value rides the async context instead of the
dependency graph, so nothing changes scope. `nestjs-cls` packages it.

The trade is the same one as the resolver's, sharper: the dependency becomes
completely invisible, and reading the store outside a request returns
`undefined` rather than failing. Reach for it when the value is genuinely
ambient across the whole app; do not reach for it to avoid one constructor
parameter.

---

## When request scope is the right answer

It earns its keep when the consumer is **deep** — several layers below anything
holding the request — and threading an argument through every layer in between
would be worse than the scope. Multi-tenant row filtering is the usual real
example: a `TenantContext` read by a repository base class, where passing a
tenant id through every call site means changing every call site.

Take it deliberately, and keep the subtree small: put the request-scoped
provider as close as possible to the code that needs it, so the number of
providers above it that inherit the scope stays low.

If the per-request rebuild is genuinely too expensive for a case like this,
Nest's **durable providers** are the escape: register a `ContextIdStrategy` that
buckets requests by tenant instead of by request, and one sub-tree is shared by
every request for that tenant. That is a different lifetime with different
correctness rules — a durable provider must hold nothing specific to a single
request — so it is a deliberate design choice, not a performance flag.

## Transient, which is a different question entirely

Transient is not "a new instance per request". It is **a private instance per
injection site**, and how long it lives is decided by its host: injected into a
singleton it is built once at boot; injected into a request-scoped provider it
is built per request, because its host is.

`ScopedLogger` is the canonical use. Each injection site gets its own instance,
handed its consumer through `INQUIRER`, so it can tag every line with that
class's name without the consumer passing its own name in:

```json
"transientLoggerHosts": ["FeatureFlagCache", "RequestContextService", "DiScopesController"]
```

Two things follow. A transient injected into a singleton **is** a singleton by
another name, so per-request state stored in one is the first request's state
for the life of the process. And transient does not propagate: a singleton that
injects a transient stays a singleton, which is why `@nestjs/terminus` can
declare all its health indicators transient without affecting anything.

## Finding it in your own application

`ScopeAudit` reads back the same computation Nest uses to decide whether to
rebuild a provider — `InstanceWrapper.isDependencyTreeStatic()` — and reports it
at boot, with the dependency chain responsible:

```
[ScopeAudit] 3 component(s) are rebuilt per request, 8 provider(s) are transient.
[ScopeAudit] AuditTrailService is rebuilt per request but never asked to be:
             AuditTrailService → RequestContextService. Pass the request data in as an
             argument, or resolve it through RequestContextResolver, to keep it a singleton.
```

It reports and does not fail: request scope is a legitimate choice, and a boot
that refuses to start over a design decision would be worse than a warning. To
hold a line, assert on it — `test/di-scopes.e2e-spec.ts` pins the exact set of
request-scoped components in this application, so injecting
`RequestContextService` into `UsersService` turns CI red instead of quietly
converting half the container.

## Deleting the demo

`src/di-scopes` is a teaching module. Delete the directory and its line in
`AppModule` and nothing else changes — nothing outside it imports it, and the
module exports only `RequestContextResolver` and `ScopeAudit`.

If you keep one thing, keep `ScopeAudit`.
