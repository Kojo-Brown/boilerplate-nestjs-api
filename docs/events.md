# Domain events — the Observer pattern on `EventEmitter2`

Something happened; whoever cares reacts. The publisher does not know who is
listening and gains no dependency by being listened to.

```ts
// Publisher — knows nothing about email.
this.events.publish("user.registered", { userId, email, name, provider });

// Subscriber — anywhere in the app, no wiring beyond being a provider.
@Injectable()
export class WelcomeEmailListener {
  @OnDomainEvent("user.registered")
  async onUserRegistered(event: DomainEvent<"user.registered">): Promise<void> {
    await this.emails.sendWelcomeEmail({ to: event.payload.email, name: ... });
  }
}
```

| Piece                  | Role in the pattern                                   |
| ---------------------- | ----------------------------------------------------- |
| `DomainEventPayloads`  | The catalogue: every event name and its payload type  |
| `DomainEventBus`       | Subject — `publish` and `publishAndSettle`            |
| `@OnDomainEvent(name)` | Observer registration, checked against the catalogue  |
| `EventsModule`         | Global wiring; `wildcard` off, `verboseMemoryLeak` on |

Everything below is the reasoning behind the parts that are not obvious.

---

## Adding an event

One entry in `DomainEventPayloads` and one payload interface, both in
`src/events/domain-event.ts`. Nothing else in `src/events` changes, and
subscribers become possible immediately.

Payloads carry identifiers and the few facts a subscriber needs — never a
Prisma row. Publishing a `User` would put the argon2 hash in front of every
listener, and the row would be stale the moment any handler awaited anything.
`user.deleted` carries the email address for a sharper reason: the row is gone
by the time a subscriber runs, so a handler that needed to look it up could not.

## Why not plain `@OnEvent`

`EventEmitter2`'s signature is `emit(name: string, ...values: any[])`, and
`@OnEvent` inherits that: the name is an unchecked string and the handler
receives `any`. Renaming a payload field then produces a runtime `undefined` in
a subscriber nobody thought to grep for. `@OnDomainEvent("user.registered")`
constrains the handler's parameter to `DomainEvent<"user.registered">`, so the
same rename is a compile error in every handler that read the field.

The decorator also wraps the method, which is the one place this codebase
departs from the "decorators write metadata, `AspectWeaver` adds behaviour"
rule in [aspects.md](./aspects.md). The aspects defer because they need a cache
and a clock that do not exist at decoration time; this wrapper closes over a
`Logger` and nothing else, so there is nothing to wait for.

## Failure containment, and why it is not optional

`EventEmitter2` invokes listeners on the publisher's stack. Without
containment, a welcome email that cannot reach Redis would throw inside
`emit()` and fail the registration that triggered it — reintroducing exactly the
coupling the pattern removes, and doing it invisibly.

So a handler that throws is caught by the wrapper and turned into a `failed`
`HandlerOutcome`. `@nestjs/event-emitter` does catch listener errors itself, but
logs `error.message` alone: no event name, no event id, no handler name. Worse,
a swallowed rejection is indistinguishable from a handler that returned
normally, so nothing downstream can report _which_ subscriber failed. Owning the
catch is what makes `publishAndSettle` able to say
`WelcomeEmailListener.onUserRegistered: failed`.

The consequence to keep in mind: **a subscriber's failure is invisible to the
publisher by design.** Do not put anything a user would notice missing behind a
listener. A welcome email is the right shape — it can be late or lost and the
account is still correct. Provisioning that account's first workspace is not:
that belongs in the transaction.

## `publish` vs `publishAndSettle`

`publish` returns once every handler has _started_ — production code wants this,
and it is deliberately not `async` so it cannot be awaited by habit. It returns
the envelope so the caller can log the event id.

`publishAndSettle` waits for every handler and reports each one. It exists for
tests, which would otherwise assert against work that has not happened yet, and
for the rare caller that genuinely depends on the reactions. Its report names
handlers registered with `@OnDomainEvent`; a plain `@OnEvent` listener is
counted but always reported `ok`, because the framework's catch runs first.

## Registration timing

`EventSubscribersLoader` registers listeners in `onApplicationBootstrap`, not
`onModuleInit`. An event published from a provider's `onModuleInit` therefore
reaches nobody — silently, because an emitter with no listeners is not an error.
Tests hit this too: `Test.createTestingModule(...).compile()` does not run
bootstrap hooks, so a spec that skips `await module.init()` is asserting against
an app with no subscribers at all. If you ever need to publish during startup,
inject `EventEmitterReadinessWatcher` and `await waitUntilReady()` first.

Listeners are removed again on `onApplicationShutdown`.

## Wildcards are off

Turning `wildcard` on changes what an event name _is_: `EventEmitter2` starts
splitting names on the delimiter and matching through a tree, so
`user.registered` becomes a two-segment path and a subscriber on `user.*`
receives events it was never named in. The names here are opaque strings that
happen to contain a dot. `delimiter` is set anyway, so the meaning of that dot
is decided in `events.module.ts` rather than by a default if wildcards are ever
switched on.

`verboseMemoryLeak` is on so the warning past `maxListeners` subscribers names
the event that leaked, which is the only part of that warning worth having.

## What this is not

Delivery is in-process and in-memory:

- a handler mid-flight when the process dies is gone, with no retry and no
  record that it was ever running;
- nothing reaches another replica — only the instance that published sees it;
- events are published inside service methods, so one emitted before a later
  statement throws describes something that did not finally happen.

These are the known limits of an event emitter, and they are why `SPEC.md`
carries a transactional-outbox item. The fix is to write the event to the
database inside the same transaction as the data and have a relay publish it
afterwards, at which point this bus becomes the relay's delivery mechanism
rather than the source of truth. Until then: nothing whose loss would be a
correctness bug goes on the bus.

## Subscribing from a request-scoped provider

Works, but the loader re-resolves the provider per event and uses the event
payload itself as the "request" for the context id, so `@Inject(REQUEST)` gives
you the event rather than an HTTP request. Prefer a singleton listener that
takes what it needs from the payload.
