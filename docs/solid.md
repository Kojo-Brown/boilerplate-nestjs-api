# SOLID audit — users module

An audit of `src/users`, the largest module in the boilerplate and the one every
other module reaches into. Each principle below is a real before/after from the
commit that introduced this file, not an invented example: the "before" column
is what was on `main`, the "after" is what is in the tree now.

The users module was chosen because it is where the pressure actually is — it
owns persistence, authorization, caching, pagination, and a JSON preferences
column, and it is consumed by `AuthService`, the controller, and the e2e suite.
Principles are easy to satisfy in a class that does one thing already.

Files introduced by this audit:

| File                                         | Purpose                                       |
| -------------------------------------------- | --------------------------------------------- |
| `users/ports/user-reader.port.ts`            | Read-side port + `USER_READER` token          |
| `users/ports/user-writer.port.ts`            | Write-side port + `USER_WRITER` token         |
| `users/ports/user-preferences-store.port.ts` | Preferences port + `USER_PREFERENCES_STORE`   |
| `users/prisma-users.repository.ts`           | Prisma adapter implementing all three         |
| `users/users.access-policy.ts`               | Ownership rules, extracted from the service   |
| `users/users-store.contract.ts`              | Behavioural contract every store must satisfy |
| `test-utils/in-memory-users.repository.ts`   | Second implementation, held to that contract  |

---

## S — Single Responsibility

> A class should have one reason to change.

**Before.** `UsersService` had two: how user data is fetched, cached and
invalidated, _and_ who is allowed to touch it. The ownership rule was inlined at
four call sites — three in the service, one in the controller — and had already
drifted, with each site carrying its own copy of the message.

```ts
// users.service.ts (before)
async updateSelf(requesterId: string, targetId: string, dto: UpdateUserDto, requesterRole: string) {
  if (requesterId !== targetId && requesterRole !== "ADMIN") {
    throw new ForbiddenException("Cannot modify another user's profile");
  }
  await this.findById(targetId);
  const updated = await this.repo.update(targetId, dto);
  await this.invalidateUserCache(targetId);
  return updated;
}

// users.controller.ts (before) — the fourth copy, in a different layer
if (requester.id !== id && requester.role !== "ADMIN") {
  throw new ForbiddenException("Cannot modify another user's avatar");
}
```

Note the shape of the signature: the requester's id is the first parameter and
their role is the fourth, with the target wedged between them. That is what
happens when an authorization concern is smeared across a data-access API —
`"user-1", "user-1", dto, "USER"` at the call site is easy to transpose and the
type checker cannot help.

**After.** The rule lives in `UserAccessPolicy`, and the identity travels as one
object.

```ts
// users.access-policy.ts
@Injectable()
export class UserAccessPolicy {
  canAct(requester: RequesterIdentity, targetUserId: string): boolean {
    return requester.id === targetUserId || requester.role === ADMIN_ROLE;
  }

  assertCanAct(requester: RequesterIdentity, targetUserId: string, action: UserOwnedAction): void {
    if (!this.canAct(requester, targetUserId)) throw new ForbiddenException(DENIAL_MESSAGE[action]);
  }
}

// users.service.ts (after)
async updateSelf(requester: RequesterIdentity, targetId: string, dto: UpdateUserDto): Promise<User> {
  this.policy.assertCanAct(requester, targetId, "update:profile");
  return this.update(targetId, dto);
}
```

The four copies became four one-line calls, and the messages are a `Record`
keyed by action, so the wording is asserted once in `users.access-policy.spec.ts`
rather than re-typed per site.

**What did _not_ move.** Role-only checks (`@Roles("ADMIN")` on list and delete)
stay in `RolesGuard`. A guard runs before the handler and cannot see the resource
id, so it can answer "is this an admin?" but not "is this yours?". Splitting on
that line keeps both mechanisms honest instead of reimplementing guards in the
service or resource lookups in a guard.

**The remaining smell.** `UsersService` still both orchestrates persistence and
manages cache invalidation. That is deliberate — the eviction keys are derived
from the same ids the writes use, and a cache-aside decorator is its own spec
item (Phase 8, `@Cacheable()`). It is called out here rather than quietly left.

---

## O — Open/Closed

> Open for extension, closed for modification.

**Before.** Extending the system with a second user store meant editing the
existing one. `UsersService` named `UsersRepository` in its constructor and
`UsersRepository` named `PrismaService` in its own, so "read users from
somewhere else" had no seam to enter through: you either edited `UsersService`,
or edited `UsersRepository` to branch internally, or subclassed a concrete class
whose constructor already built an extended Prisma client.

Tests paid the same tax. Because there was nothing to substitute, the service
spec had to fabricate the store method by method:

```ts
// users.service.spec.ts (before)
const mockRepo = {
  findById: jest.fn(),
  findByEmail: jest.fn(),
  findByProviderAccount: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  getPreferences: jest.fn(),
  setPreferences: jest.fn(),
};

mockRepo.findById.mockResolvedValue(mockUser);
mockRepo.update.mockResolvedValue({ ...mockUser, name: "Updated" });
const result = await service.update("user-1", { name: "Updated" });
expect(mockRepo.update).toHaveBeenCalledWith("user-1", { name: "Updated" });
```

Those assertions check that the service called the mock the way the mock expects
to be called. They pass whether or not the update actually happened.

**After.** A new store is a new class. Nothing in `UsersService` changes:

```ts
// test-utils/in-memory-users.repository.ts
export class InMemoryUsersRepository implements UsersStore {
  /* ... */
}

// users.service.spec.ts (after) — a real store, bound to the same tokens
const store = new InMemoryUsersRepository();
const module = await Test.createTestingModule({
  providers: [
    UsersService,
    UserAccessPolicy,
    { provide: USER_READER, useValue: store },
    { provide: USER_WRITER, useValue: store },
    { provide: USER_PREFERENCES_STORE, useValue: store },
    { provide: CacheService, useValue: mockCache },
  ],
}).compile();

store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });
await expect(service.updateSelf(asUser("user-2"), "user-1", { name: "Hack" })).rejects.toThrow(
  ForbiddenException,
);
await expect(service.findById("user-1")).resolves.toMatchObject({ name: "Test User" });
```

The second assertion is the point: the forbidden write left no trace. No
arrangement of mock expectations can state that.

This is the same seam DIP creates, seen from the other side — DIP is about which
way the dependency arrow points, OCP is about what that buys you. They are
listed separately because the payoff shows up in different places: DIP in
`users.module.ts`, OCP in every consumer that never had to change.

---

## L — Liskov Substitution

> A subtype must be usable anywhere its supertype is, without the caller
> knowing.

**Before.** Nothing enforced this, because there was only ever one
implementation and its stand-ins were ad-hoc mocks. A double is free to
strengthen preconditions or weaken postconditions and TypeScript will not
notice: `findById` returning `undefined` where Prisma returns `null` type-checks
against `Promise<User | null>` only if you are careless once, and
`update("missing", …)` resolving where Prisma rejects with P2025 type-checks
always. Both make a green suite meaningless — the service's `if (!user) throw
new NotFoundException(...)` branch is exactly the code such a divergence hides.

**After.** The contract is written once and run against every implementation:

```ts
// users-store.contract.ts
export function describeUsersStoreContract(name: string, createStore: () => UsersStore): void {
  describe(`${name} (users store contract)`, () => {
    it("resolves with null — not undefined — for an unknown id", async () => {
      await expect(store.findById("missing")).resolves.toBeNull();
    });

    it("rejects for an unknown id instead of creating a row", async () => {
      await expect(store.update("missing", { name: "Nobody" })).rejects.toThrow();
      await expect(store.findById("missing")).resolves.toBeNull();
    });

    it("resolves with the defaults for an unknown id rather than rejecting", async () => {
      await expect(store.getPreferences("missing")).resolves.toEqual(DEFAULT_USER_PREFERENCES);
    });
    // ...
  });
}

// users-store.contract.spec.ts
describeUsersStoreContract("PrismaUsersRepository", () => new PrismaUsersRepository(fakePrisma()));
describeUsersStoreContract("InMemoryUsersRepository", () => new InMemoryUsersRepository());
```

Adding a store is one line there, not a copied file of assertions. The third
clause above is the kind of asymmetry a contract is for: `getPreferences`
resolves with defaults for an unknown id while `setPreferences` rejects, because
an absent row and an unset JSON column are the same "nothing stored yet" to a
reader but not to a writer. Surprising, easy to get wrong in a second
implementation, and now pinned for both.

**Limit of the mechanism, stated plainly.** The Prisma leg of the contract runs
against a `Map`-backed stand-in for `PrismaService`, not a database. It proves
the adapter _builds the right queries_ and that both implementations agree on
observable behaviour; it does not prove PostgreSQL agrees. Testcontainers-backed
integration tests are a separate spec item (Phase 13) and are what would close
that gap.

---

## I — Interface Segregation

> No client should be forced to depend on methods it does not use.

**Before.** One class, ten public methods, three unrelated jobs — row reads, row
writes, and a JSON preferences column reached through a Prisma client extension:

```ts
// users.repository.ts (before)
@Injectable()
export class UsersRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null>;
  findMany(args: { cursor?: string; limit: number; search?: string }): Promise<User[]>;
  create(data: Prisma.UserCreateInput): Promise<User>;
  update(id: string, data: Prisma.UserUpdateInput): Promise<User>;
  delete(id: string): Promise<User>;
  getPreferences(id: string): Promise<UserPreferences>;
  setPreferences(id: string, patch: Partial<UserPreferences>): Promise<UserPreferences>;
}
```

Every consumer depended on all ten. `AuthService`, which only ever looks a user
up and creates one, was transitively coupled to `delete` and to the preferences
extension; any test double for any consumer had to stub the full surface.

**After.** Three role interfaces, split by who calls them:

```ts
export interface UserReader {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null>;
  findMany(query: UserListQuery): Promise<User[]>;
}

export interface UserWriter {
  create(data: CreateUserData): Promise<User>;
  update(id: string, data: UpdateUserData): Promise<User>;
  delete(id: string): Promise<User>;
}

export interface UserPreferencesStore {
  getPreferences(id: string): Promise<UserPreferences>;
  setPreferences(id: string, patch: Partial<UserPreferences>): Promise<UserPreferences>;
}
```

`UsersService` injects all three because it genuinely spans all three; the
point is that a read-only consumer can now depend on four methods instead of
ten, and adding a write-side method cannot break it.

**One adapter still implements all three**, and that is not a contradiction: the
interfaces are segregated for the consumers' benefit, not to force three
databases on anyone who has one. `UsersStore` (the intersection) exists only for
the adapter and the contract suite — no consumer should depend on it, since
depending on the union is precisely the fat interface this removed.

**Also gone: the Prisma leak.** The payloads were `Prisma.UserCreateInput` and
`Prisma.UserUpdateInput`, so the service layer spoke Prisma's nested-write
dialect and no non-Prisma adapter could honestly satisfy the type. They are now
`CreateUserData` and `UpdateUserData`, owned by this module.

---

## D — Dependency Inversion

> Depend on abstractions, not concretions. High-level policy should not import
> low-level detail.

**Before.** The arrow pointed straight down, from policy to Prisma:

```ts
// users.service.ts (before)
constructor(
  private readonly repo: UsersRepository,   // a concrete class
  private readonly cache: CacheService,
) {}

// users.repository.ts (before)
constructor(private readonly prisma: PrismaService) {
  this.extended = prisma.withExtensions();
}

// users.module.ts (before)
providers: [UsersService, UsersRepository],
```

`UsersService` → `UsersRepository` → `PrismaService` → `PrismaClient`. Nest
resolved the class as its own token, so the only way to substitute anything was
`overrideProvider(UsersRepository)` in a test — which works, and hides that
production code has no seam at all.

**After.** Both sides depend on the ports; the module is the only place that
knows which adapter is wired in.

```ts
// users.service.ts (after)
constructor(
  @Inject(USER_READER) private readonly reader: UserReader,
  @Inject(USER_WRITER) private readonly writer: UserWriter,
  @Inject(USER_PREFERENCES_STORE) private readonly preferences: UserPreferencesStore,
  private readonly cache: CacheService,
  private readonly policy: UserAccessPolicy,
) {}

// users.module.ts (after)
providers: [
  UsersService,
  UserAccessPolicy,
  PrismaUsersRepository,
  { provide: USER_READER, useExisting: PrismaUsersRepository },
  { provide: USER_WRITER, useExisting: PrismaUsersRepository },
  { provide: USER_PREFERENCES_STORE, useExisting: PrismaUsersRepository },
],
```

Three decisions worth spelling out:

- **Tokens are `Symbol`s, not strings.** A TypeScript interface is erased at
  runtime, so Nest needs a runtime token to inject one — `@Inject(USER_READER)`
  rather than the type. Symbols cannot collide across modules by accident and
  cannot be produced from user input.
- **`useExisting`, not `useClass`.** `useClass` would instantiate
  `PrismaUsersRepository` once per token, and each instance builds its own
  extended Prisma client. `useExisting` aliases all three tokens to the single
  registered provider.
- **The adapter still imports Prisma, and should.** DIP inverts the _policy_
  layer's dependency, not every dependency. `PrismaUsersRepository` is the
  low-level detail; its job is to know Prisma so that nothing above it does.

**Where the arrow still points the wrong way.** `AuthService` injects
`PrismaService` directly for refresh-token rows. That is a genuine finding this
audit does not fix: refresh tokens are their own aggregate and deserve their own
port, and hauling them in here would have made this change two features wide.
It is recorded rather than glossed — Phase 12's refresh-token-reuse item is the
natural place for it.

---

## Scorecard

| Principle | Before                                                   | After                                                       |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| SRP       | Ownership checks inlined at 4 sites across 2 layers      | `UserAccessPolicy`; cache/orchestration split noted as open |
| OCP       | New store ⇒ edit `UsersService` or `UsersRepository`     | New store ⇒ new class, zero edits to consumers              |
| LSP       | Substitutability unchecked; doubles could diverge freely | One contract suite run against both implementations         |
| ISP       | 1 class, 10 methods, every consumer depends on all of it | 3 role interfaces; Prisma input types no longer leak upward |
| DIP       | `UsersService` → concrete repo → `PrismaService`         | Both sides depend on ports; wiring confined to the module   |

Open items, deliberately not addressed here: cache-aside orchestration inside
`UsersService`, and `AuthService`'s direct `PrismaService` dependency for
refresh tokens.
