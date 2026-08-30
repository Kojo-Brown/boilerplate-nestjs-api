import { Role } from "@prisma/client";
import type { User } from "@prisma/client";
import { DEFAULT_USER_PREFERENCES, mergePreferences } from "@/users/types/user-preferences";
import type { UserPreferences } from "@/users/types/user-preferences";

function cuid(): string {
  return "c" + Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}

/**
 * The extended-unique `where` the optimistic-concurrency writes use: a unique
 * id plus, optionally, the versions the caller is willing to overwrite.
 */
interface VersionedWhere {
  id: string;
  version?: { in: number[] };
}

/** `data` as the repository sends it — `version` arrives as an atomic increment. */
type UserWriteData = Partial<Omit<User, "version">> & { version?: { increment: number } };

function matchesVersion(where: VersionedWhere, actual: number): boolean {
  return where.version === undefined || where.version.in.includes(actual);
}

function applyWrite(data: UserWriteData, current: User): Partial<User> {
  const { version, ...rest } = data;
  if (version === undefined) return rest;
  return { ...rest, version: current.version + version.increment };
}

export class InMemoryPrismaService {
  readonly _users = new Map<string, User>();

  readonly user = {
    findUnique: (args: {
      where: { id?: string; email?: string };
      select?: Record<string, boolean>;
      include?: Record<string, boolean>;
    }): Promise<User | null> => {
      if (args.where.id) return Promise.resolve(this._users.get(args.where.id) ?? null);
      if (args.where.email) {
        for (const u of this._users.values()) {
          if (u.email === args.where.email) return Promise.resolve(u);
        }
      }
      return Promise.resolve(null);
    },

    findFirst: (args: {
      where: Partial<Pick<User, "provider" | "providerAccountId">>;
    }): Promise<User | null> => {
      for (const u of this._users.values()) {
        if (
          args.where.provider !== undefined &&
          args.where.providerAccountId !== undefined &&
          u.provider === args.where.provider &&
          u.providerAccountId === args.where.providerAccountId
        ) {
          return Promise.resolve(u);
        }
      }
      return Promise.resolve(null);
    },

    findMany: (args: {
      take?: number;
      skip?: number;
      cursor?: { id: string };
      orderBy?: unknown;
      where?: {
        OR?: Array<{
          name?: { contains: string; mode: string };
          email?: { contains: string; mode: string };
        }>;
      };
    }): Promise<User[]> => {
      let all = [...this._users.values()].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );

      if (args.where?.OR) {
        const search = args.where.OR[0]?.name?.contains ?? args.where.OR[0]?.email?.contains ?? "";
        const lower = search.toLowerCase();
        all = all.filter(
          (u) => u.name?.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower),
        );
      }

      let start = 0;
      if (args.cursor?.id) {
        const idx = all.findIndex((u) => u.id === args.cursor!.id);
        if (idx >= 0) start = idx + 1;
      }
      if (args.skip) start += args.skip;

      const result =
        args.take !== undefined ? all.slice(start, start + args.take) : all.slice(start);
      return Promise.resolve(result);
    },

    create: (args: { data: Partial<User> & { email: string } }): Promise<User> => {
      const user: User = {
        id: cuid(),
        role: Role.USER,
        provider: null,
        providerAccountId: null,
        avatarUrl: null,
        preferences: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        password: null,
        name: null,
        version: 0,
        ...provided(args.data),
      };
      this._users.set(user.id, user);
      return Promise.resolve(user);
    },

    update: (args: {
      where: VersionedWhere;
      data: UserWriteData;
      select?: Record<string, boolean>;
    }): Promise<User> => {
      const user = this._users.get(args.where.id);
      // Rejecting for a version mismatch with the same "Record not found" the
      // real client raises (P2025) is the point: `PrismaUsersRepository` is
      // then forced to tell the two apart by reading the row back, exactly as
      // it must against Postgres. A fake that raised a distinguishable error
      // would let a bug where the repository trusts the error message pass.
      if (!user || !matchesVersion(args.where, user.version)) {
        return Promise.reject(new Error("Record not found"));
      }
      const updated: User = { ...user, ...applyWrite(args.data, user), updatedAt: new Date() };
      this._users.set(args.where.id, updated);
      return Promise.resolve(updated);
    },

    delete: (args: { where: VersionedWhere }): Promise<User> => {
      const user = this._users.get(args.where.id);
      if (!user || !matchesVersion(args.where, user.version)) {
        return Promise.reject(new Error("Record not found"));
      }
      this._users.delete(args.where.id);
      return Promise.resolve(user);
    },
  };

  withExtensions() {
    return {
      user: {
        // Merged over `DEFAULT_USER_PREFERENCES` rather than over a copy of it,
        // the same way `preferencesExtension` does. A hand-written default here
        // drifts the moment a preference is added, and the fake then answers
        // with fields the real store would never omit.
        getPreferences: (id: string): Promise<UserPreferences> => {
          const user = this._users.get(id);
          if (!user) return Promise.reject(new Error("User not found"));
          const stored = user.preferences as Partial<UserPreferences> | null;
          return Promise.resolve(mergePreferences(DEFAULT_USER_PREFERENCES, stored ?? {}));
        },
        setPreferences: (
          id: string,
          patch: Partial<UserPreferences>,
          versionFilter?: { in: number[] },
        ): Promise<{ preferences: UserPreferences; version: number }> => {
          const user = this._users.get(id);
          if (!user) return Promise.reject(new Error("User not found"));
          // The real extension puts this filter in the `where` of its `update`,
          // so a mismatch surfaces there as a missing record, not before it.
          if (!matchesVersion({ id, version: versionFilter }, user.version)) {
            return Promise.reject(new Error("Record not found"));
          }
          const current = mergePreferences(
            DEFAULT_USER_PREFERENCES,
            (user.preferences as Partial<UserPreferences> | null) ?? {},
          );
          const updated = mergePreferences(current, patch);
          const version = user.version + 1;
          this._users.set(id, {
            ...user,
            preferences: updated as unknown as User["preferences"],
            updatedAt: new Date(),
            version,
          });
          return Promise.resolve({ preferences: updated, version });
        },
      },
    };
  }

  /**
   * Runs the callback with this same fake as the "transaction client".
   *
   * Enough for what the suite needs: `PrismaTransactionRunner` hands the
   * callback a handle, the adapters narrow it back with
   * `requirePrismaTransaction`, and the writes land in the same maps as
   * everything else. That keeps `PrismaUsersRepository` — rather than a
   * substitute for it — running in the e2e suite once the outbox gave it a
   * transaction to join.
   *
   * What it deliberately does not do is roll its own maps back. Compensations
   * registered through `tx.onRollback` still run, which is what the in-memory
   * outbox uses to discard a staged event, but a `user.create` that this fake
   * has already applied stays applied. Atomicity is a property of Postgres and
   * is asserted against a real one in `test/outbox-store.db-spec.ts`; claiming
   * it here would be a fake reporting that the database behaves correctly
   * while never having asked it.
   */
  $transaction = <T>(work: (client: InMemoryPrismaService) => Promise<T>): Promise<T> => work(this);

  $connect = () => Promise.resolve();
  $disconnect = () => Promise.resolve();

  reset() {
    this._users.clear();
  }
}

/**
 * `data` with its `undefined` values dropped.
 *
 * Prisma's rule, and the fake has to share it: `undefined` in a `data` object
 * means *not provided*, so a nullable column left unset is stored as NULL and
 * read back as `null`. Spreading the caller's object straight over the defaults
 * instead lets an explicit `undefined` overwrite that `null` — which is not a
 * value any Prisma client would ever return, and not a value any TypeScript
 * signature in this repository admits either.
 *
 * Found by the event schema contract: `AuthService` stages `user.registered`
 * with `name: user.name`, registration without a name produced `name:
 * undefined` here where Postgres produces `null`, and the contract rejected a
 * payload that is correct against a real database. The divergence was harmless
 * only for as long as nothing looked.
 */
type Provided<T> = { [K in keyof T]: Exclude<T[K], undefined> };

function provided<T extends object>(data: T): Provided<T> {
  // The cast is `Object.fromEntries`'s doing — it types every result as
  // `Record<string, unknown>` — not a claim about the filter, which only ever
  // removes keys whose value was `undefined`.
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as Provided<T>;
}
