# CQRS — commands, queries, and a read model that catches up

The users module is split in two. A write goes through a command; a read goes
through a query; and one projection reacts to a domain event to fix the read
model where no write path could reach it.

```ts
// Write side — a request to change something, answered by exactly one handler.
await this.commands.execute(new UpdateUserProfileCommand(requester, id, dto, expected));

// Read side — a question, answered by exactly one handler.
const user = await this.queries.execute(new GetUserQuery(id));
```

| Piece                                          | Role                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `src/users/write/*.command`                    | Command + its `@CommandHandler`, co-located                      |
| `src/users/write/user-write-model.ts`          | Preconditions, conflict → 412, post-write eviction               |
| `src/users/read/*.query`                       | Query + its `@QueryHandler`, co-located                          |
| `src/users/read/users-read-model.cache.ts`     | The read model's cache and its key layout                        |
| `src/users/read/users-read-model.projector.ts` | The one `@EventsHandler`                                         |
| `src/cqrs/`                                    | `CqrsModule.forRoot()`, the domain-event bridge, the failure log |

`UsersService` is gone. It was not wrapped, and that is the point: a service
kept alongside the handlers would be a second write path, and the next change
would update one of them.

---

## What the split actually bought

Three things, and none of them is "the pattern".

**`AuthService` no longer imports the users module.** It dispatches
`CreateUserCommand`, `UpdateUserCommand`, `FindUserByEmailQuery` and
`FindUserByProviderAccountQuery`. Its dependency is on four request shapes
rather than on a class with fourteen methods, so the users module can split a
handler in two or move where a row lives without touching auth.

**The controller has no decisions left in it.** Ownership checks, preconditions,
the S3 upload and the avatar object key all moved into handlers, because each of
them is part of what the operation _means_ rather than how it arrived. What is
left is genuinely HTTP: multipart limits, cache interceptors, the `ETag`, the
OpenAPI description. The avatar endpoint went from six statements to two.

**A latent bug came out.** `GET /v1/users` is cached for 60s under one key.
Registration happens in `AuthService`, which has no business knowing that. Before
`UsersReadModelProjector` nothing evicted that key on a registration, so a new
account was missing from the admin list for up to a minute — not wrong, just
old, which is why nobody ever reported it. Once the read side owns its cache, the
question "who tells it a user now exists?" has an obvious answer and an obvious
gap. `test/users.e2e-spec.ts` asserts the whole chain: the row and
`user.registered` commit together, the relay publishes, the bridge forwards, the
projection evicts.

---

## Two event mechanisms, one direction

This codebase already had an event backbone before `@nestjs/cqrs` arrived, and
adding a second one that competed with it would have been the expensive mistake.
So the CQRS `EventBus` is not a backbone. It is fed by `DomainEventCqrsBridge`
and by nothing else:

```
outbox row ─commit─▶ relay ─▶ DomainEventBus ─▶ DomainEventCqrsBridge ─▶ EventBus ─▶ @EventsHandler
Kafka topic ──────▶ DomainEventConsumer ─┘
```

No command handler publishes an integration event onto the CQRS bus. An event
exists because a row was written, not because a handler said so — which is what
keeps the ordering honest and keeps the schema registry, the outbox and the
broker codec in the path of everything that leaves the process.

**What that means for an `@EventsHandler`.** `EventBus.publish` is
`subject$.next(event)`. It returns before any handler has finished, reports
nothing about them, and retries nothing. A handler that throws is caught by the
bus and pushed onto `UnhandledExceptionBus`, which by default has _no subscriber
at all_ — which is why `CqrsUnhandledExceptionLogger` exists. Without it, a
projection that has been dead since a deploy three weeks ago produces no log
line, no metric, and no failed request.

So the rule is: work whose loss would be a correctness bug does not belong on
the CQRS event bus. It belongs on `@OnDomainEvent`, where `publishAndSettle`
names the handler that failed and the relay can hold the row back. What belongs
here is work that is safe to lose and cheap to redo — cache eviction, in-memory
read models rebuilt on demand. The bridge's spec pins the other half of that
bargain: a projection that throws must not be able to make the relay hold a row
back, because the CQRS bus offers no retry that could ever clear it.

The logger logs and does not rethrow. `rethrowUnhandled` would turn a failed
projection into an unhandled rejection on whichever stack published the event —
the outbox relay, or a WebSocket frame — and take the process down for work that
was explicitly chosen as safe to lose.

## Eviction is synchronous; projection is not

The one deliberate exception to "the read model is updated by events".

A client that writes and immediately reads must not be served the value it just
replaced, and an eviction that happens a relay poll later cannot promise that.
So command handlers evict through `UsersReadModelCache` on the way out, and
`DeleteUserHandler` evicts _inside_ its transaction — early enough that a
subscriber reading back the moment the commit lands cannot find the deleted row
cached, and safe in the other direction because a rollback leaves the cache
merely cold.

`UsersReadModelProjector` also evicts on `user.deleted`, which is therefore
redundant on the replica that served the delete. Deliberately: eviction is
idempotent, and the alternative is a handler that has to know which replica it
is. It stops being redundant with more than one process — `DomainEventConsumer`
puts what it reads off the broker onto the same bus, so a delete served
elsewhere arrives indistinguishably from a local one. That matters whenever the
cache is per-process, which is what `AppCacheModule` falls back to with no
`REDIS_URL`.

## Registering the module once

`CqrsModule.forRoot()` is imported exactly once, in `AppCqrsModule`. The bare
`CqrsModule` is an ordinary module, so importing it a second time in a feature
module builds a _second_ `CommandBus`, `QueryBus` and `EventBus` in that
module's injector — while `ExplorerService` registers every discovered handler
against the buses of whichever `CqrsModule` instance ran
`onApplicationBootstrap`. Half the application then dispatches into a bus with
no handlers, and the symptom is a `CommandHandlerNotFoundException` for a
handler that is plainly in the providers list. `forRoot()` returns
`global: true`, so nothing needs to import anything.

Handlers stay in the module that owns them. The explorer walks the whole
container and does not care where a `@CommandHandler` lives, and keeping them in
the feature module is what stops `src/cqrs` from becoming a registry of
everything.

## Typing

Commands and queries extend `Command<TResult>` and `Query<TResult>`:

```ts
export class GetUserQuery extends Query<User> {
  constructor(readonly id: string) {
    super();
  }
}

const user = await this.queries.execute(new GetUserQuery(id)); // Promise<User>
```

Without the generic parameter, `execute` resolves to `any` and the bus quietly
erases the types at every call site — which would trade a class with typed
methods for a bus with none, and be a strict loss.

## The command that carries a transaction

`CreateUserCommand` takes an optional `TransactionContext`, and that is a
departure from orthodox CQRS: a command is supposed to be a self-contained
request, and this one carries a live transaction handle.

The alternatives were worse in both directions. Registration cannot move into
the users module — it hashes with argon2, issues refresh tokens and stages
`user.registered`. And the row and that event have to commit together, or a
crash between them produces either a registration nobody is told about or a
`user.registered` for an insert that rolled back. So `AuthService` keeps the
unit of work and passes it in. `UserWriter.create` already accepted `tx` in the
same trailing position for exactly this reason.

## Testing

`src/users/users.cqrs.spec.ts` dispatches through the real `CommandBus` and
`QueryBus` rather than calling handlers directly. That costs one
`module.init()` — `compile()` builds the container, but `onApplicationBootstrap`
is what binds handlers to their commands — and buys an assertion no per-handler
unit test can make: that the command class really is bound to the handler that
claims it. The failure it catches surfaces in production as a
`CommandHandlerNotFoundException` on an endpoint nobody changed.

The controller's own spec asserts the _command object_ that was dispatched, not
the effect of running it, because that is the only mistake the controller can
still make: an argument in the wrong position, a requester dropped, an
`If-Match` used for the pre-check and then not passed to the write.

## Not done

- **The read model is the write model.** Queries read the same `User` rows
  through `USER_READER`; there is no separate denormalised store and no
  eventual consistency between the two. The projection maintains a _cache_,
  not a second copy of the data. A genuine read store would need events for
  profile and preference changes, which the catalogue does not carry, and those
  are only worth adding when a read shape actually exists that the write schema
  serves badly.
- **No `AggregateRoot` and no `EventPublisher`.** `@nestjs/cqrs`'s aggregate
  helpers buffer events on an entity and flush them on `commit()`. That is a
  third place events can come from, in a codebase where the outbox is the only
  durable one, so it is deliberately unused.
- **Sagas are the next spec item.** `@Saga` and the `ICommand` stream are
  untouched here; the ordering flow and its compensations land with that item.
- **Only the users module is split.** `payments`, `storage` and `notifications`
  still expose services. Converting them wholesale would be pattern application
  rather than a change with a reason behind it; the buses are global, so any of
  them can move when it has one.
