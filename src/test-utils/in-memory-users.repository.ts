import { Role } from "@prisma/client";
import type { User } from "@prisma/client";
import { DEFAULT_USER_PREFERENCES, mergePreferences } from "@/users/types/user-preferences";
import type { UserPreferences } from "@/users/types/user-preferences";
import { VersionConflictError, isSatisfiedBy } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type {
  CreateUserData,
  PreferencesWriteResult,
  UpdateUserData,
  UserListQuery,
  UsersStore,
} from "@/users/ports";

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `c${sequence.toString().padStart(24, "0")}`;
}

/**
 * In-memory implementation of the three user ports.
 *
 * This exists to be substituted for `PrismaUsersRepository` in tests that care
 * about the users module's behaviour rather than about SQL. It is held to the
 * same behavioural contract as the Prisma adapter by
 * `users-store.contract.spec.ts` — a double that quietly returned `undefined`
 * where Prisma returns `null`, or resolved where Prisma rejects, would make
 * green tests meaningless, which is the LSP failure the contract suite exists
 * to catch.
 */
export class InMemoryUsersRepository implements UsersStore {
  private readonly users = new Map<string, User>();
  private readonly preferences = new Map<string, Partial<UserPreferences>>();

  /** Seeds a row directly, bypassing `create`, for arranging test state. */
  seed(overrides: Partial<User> & Pick<User, "id">): User {
    const now = new Date();
    const user: User = {
      email: `${overrides.id}@example.test`,
      password: null,
      name: null,
      role: Role.USER,
      provider: null,
      providerAccountId: null,
      avatarUrl: null,
      preferences: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
      ...overrides,
    };
    this.users.set(user.id, user);
    return user;
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  findByEmail(email: string): Promise<User | null> {
    return Promise.resolve([...this.users.values()].find((u) => u.email === email) ?? null);
  }

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    const match = [...this.users.values()].find(
      (u) => u.provider === provider && u.providerAccountId === providerAccountId,
    );
    return Promise.resolve(match ?? null);
  }

  findMany(query: UserListQuery): Promise<User[]> {
    let rows = [...this.users.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    if (query.search) {
      const needle = query.search.toLowerCase();
      rows = rows.filter(
        (u) =>
          u.email.toLowerCase().includes(needle) ||
          (u.name?.toLowerCase().includes(needle) ?? false),
      );
    }

    // Matches Prisma's `cursor` + `skip: 1`: the cursor row is excluded, and an
    // unknown cursor yields the whole set rather than an error.
    if (query.cursor) {
      const index = rows.findIndex((u) => u.id === query.cursor);
      if (index >= 0) rows = rows.slice(index + 1);
    }

    return Promise.resolve(rows.slice(0, query.limit + 1));
  }

  /**
   * `tx` is honoured the only way a `Map` can honour one: by registering a
   * compensation that removes the row again if the unit of work fails. That is
   * weaker than a transaction — it cannot cover a commit that fails after the
   * callback returned — but it is enough to keep a rolled-back registration
   * from leaving a user behind, which is what a spec exercising the outbox is
   * actually asking about.
   */
  create(data: CreateUserData, tx?: TransactionContext): Promise<User> {
    const now = new Date();
    const user: User = {
      id: nextId(),
      email: data.email,
      password: data.password ?? null,
      name: data.name ?? null,
      role: Role.USER,
      provider: data.provider ?? null,
      providerAccountId: data.providerAccountId ?? null,
      avatarUrl: null,
      preferences: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    this.users.set(user.id, user);
    tx?.onRollback(() => {
      this.users.delete(user.id);
    });
    return Promise.resolve(user);
  }

  update(
    id: string,
    data: UpdateUserData,
    expected: ExpectedVersion,
    tx?: TransactionContext,
  ): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) return Promise.reject(new Error(`User ${id} not found`));
    if (!isSatisfiedBy(expected, existing.version)) {
      return Promise.reject(new VersionConflictError(existing.version));
    }
    const updated: User = {
      ...existing,
      name: data.name ?? existing.name,
      provider: data.provider ?? existing.provider,
      providerAccountId: data.providerAccountId ?? existing.providerAccountId,
      avatarUrl: data.avatarUrl ?? existing.avatarUrl,
      updatedAt: new Date(),
      version: existing.version + 1,
    };
    this.users.set(id, updated);
    tx?.onRollback(() => {
      this.users.set(id, existing);
    });
    return Promise.resolve(updated);
  }

  delete(id: string, expected: ExpectedVersion, tx?: TransactionContext): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) return Promise.reject(new Error(`User ${id} not found`));
    if (!isSatisfiedBy(expected, existing.version)) {
      return Promise.reject(new VersionConflictError(existing.version));
    }
    const preferences = this.preferences.get(id);
    this.users.delete(id);
    this.preferences.delete(id);
    tx?.onRollback(() => {
      this.users.set(id, existing);
      if (preferences) this.preferences.set(id, preferences);
    });
    return Promise.resolve(existing);
  }

  getPreferences(id: string): Promise<UserPreferences> {
    return Promise.resolve(
      mergePreferences(DEFAULT_USER_PREFERENCES, this.preferences.get(id) ?? {}),
    );
  }

  setPreferences(
    id: string,
    patch: Partial<UserPreferences>,
    expected: ExpectedVersion,
  ): Promise<PreferencesWriteResult> {
    const user = this.users.get(id);
    if (!user) return Promise.reject(new Error(`User ${id} not found`));
    if (!isSatisfiedBy(expected, user.version)) {
      return Promise.reject(new VersionConflictError(user.version));
    }
    // Through `mergePreferences`, like the Prisma adapter: an implementation
    // that spread the patch itself would drop every key the caller left
    // `undefined`, and the contract suite would catch it here rather than in
    // whatever endpoint used this double.
    const current = mergePreferences(DEFAULT_USER_PREFERENCES, this.preferences.get(id) ?? {});
    const merged = mergePreferences(current, patch);
    this.preferences.set(id, merged);
    // Preferences are a projection of the user row in the Prisma adapter, so
    // writing them moves that row's version there. Keeping the same rule here
    // is what lets the contract suite assert it once for both.
    const version = user.version + 1;
    this.users.set(id, { ...user, version, updatedAt: new Date() });
    return Promise.resolve({ preferences: merged, version });
  }
}
