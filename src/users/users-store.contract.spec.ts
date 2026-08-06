import { Role } from "@prisma/client";
import type { User } from "@prisma/client";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { describeUsersStoreContract } from "./users-store.contract";
import { DEFAULT_USER_PREFERENCES, mergePreferences } from "./types/user-preferences";
import type { UserPreferences } from "./types/user-preferences";
import type { CreateUserData, UpdateUserData } from "./ports";
import { InMemoryUsersRepository } from "@/test-utils/in-memory-users.repository";
import type { PrismaService } from "@/common/prisma/prisma.service";

/**
 * A stand-in for the pieces of `PrismaService` the adapter touches, backed by a
 * Map.
 *
 * It reproduces the semantics the adapter relies on — `findUnique` resolving
 * with `null`, `update`/`delete` rejecting on a missing row (Prisma's P2025),
 * `cursor` + `skip: 1` excluding the cursor row, `mode: "insensitive"` — so the
 * contract exercises `PrismaUsersRepository`'s real query building rather than
 * a mock that agrees with whatever the adapter happens to send.
 *
 * The preference methods mirror `preferencesExtension` rather than running it:
 * the extension is Prisma-client machinery and is unit-tested directly in
 * `prisma.extensions.spec.ts`. What this pins is that the *adapter* exposes the
 * same preference behaviour the in-memory store does.
 */
class FakePrismaClient {
  private readonly rows = new Map<string, User>();
  private sequence = 0;

  readonly user = {
    findUnique: ({ where }: { where: { id?: string; email?: string } }): Promise<User | null> => {
      if (where.id !== undefined) return Promise.resolve(this.rows.get(where.id) ?? null);
      if (where.email !== undefined) {
        return Promise.resolve(
          [...this.rows.values()].find((u) => u.email === where.email) ?? null,
        );
      }
      return Promise.resolve(null);
    },

    findFirst: ({
      where,
    }: {
      where: { provider?: string; providerAccountId?: string };
    }): Promise<User | null> => {
      const match = [...this.rows.values()].find(
        (u) => u.provider === where.provider && u.providerAccountId === where.providerAccountId,
      );
      return Promise.resolve(match ?? null);
    },

    findMany: (args: {
      take: number;
      skip: number;
      cursor?: { id: string };
      orderBy: { createdAt: "asc" };
      where?: {
        OR: Array<
          | { name: { contains: string; mode: "insensitive" } }
          | { email: { contains: string; mode: "insensitive" } }
        >;
      };
    }): Promise<User[]> => {
      let rows = [...this.rows.values()].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );

      const clauses = args.where?.OR;
      if (clauses) {
        rows = rows.filter((row) =>
          clauses.some((clause) => {
            if ("name" in clause) {
              return (row.name ?? "").toLowerCase().includes(clause.name.contains.toLowerCase());
            }
            return row.email.toLowerCase().includes(clause.email.contains.toLowerCase());
          }),
        );
      }

      if (args.cursor) {
        const index = rows.findIndex((u) => u.id === args.cursor?.id);
        if (index >= 0) rows = rows.slice(index);
      }

      return Promise.resolve(rows.slice(args.skip, args.skip + args.take));
    },

    create: ({ data }: { data: CreateUserData }): Promise<User> => {
      this.sequence += 1;
      const now = new Date();
      const row: User = {
        id: `c${this.sequence.toString().padStart(24, "0")}`,
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
      };
      this.rows.set(row.id, row);
      return Promise.resolve(row);
    },

    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: UpdateUserData | { preferences: UserPreferences };
    }): Promise<User> => {
      const existing = this.rows.get(where.id);
      if (!existing) {
        return Promise.reject(
          new Error(
            "An operation failed because it depends on one or more records that were " +
              "required but not found. (P2025)",
          ),
        );
      }
      // Prisma ignores keys whose value is `undefined`; spreading `data`
      // wholesale would overwrite columns with undefined instead.
      const patch = Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
      );
      const updated: User = { ...existing, ...patch, updatedAt: new Date() };
      this.rows.set(where.id, updated);
      return Promise.resolve(updated);
    },

    delete: ({ where }: { where: { id: string } }): Promise<User> => {
      const existing = this.rows.get(where.id);
      if (!existing) {
        return Promise.reject(new Error("Record to delete does not exist. (P2025)"));
      }
      this.rows.delete(where.id);
      return Promise.resolve(existing);
    },
  };

  withExtensions() {
    return {
      user: {
        getPreferences: (id: string): Promise<UserPreferences> => {
          const stored = this.rows.get(id)?.preferences as Partial<UserPreferences> | null;
          return Promise.resolve(mergePreferences(DEFAULT_USER_PREFERENCES, stored ?? {}));
        },

        setPreferences: (id: string, patch: Partial<UserPreferences>): Promise<UserPreferences> => {
          const existing = this.rows.get(id);
          if (!existing) return Promise.reject(new Error(`User ${id} not found`));
          // Same merge helper the real extension uses — this fake stands in
          // for `preferencesExtension`, so it has to agree with it about
          // what a patch key set to `undefined` means.
          const current = mergePreferences(
            DEFAULT_USER_PREFERENCES,
            (existing.preferences as Partial<UserPreferences> | null) ?? {},
          );
          const merged = mergePreferences(current, patch);
          this.rows.set(id, { ...existing, preferences: merged });
          return Promise.resolve(merged);
        },
      },
    };
  }
}

// The adapter only ever touches `user` and `withExtensions()`; typing the fake
// as a full `PrismaService` would mean stubbing the whole generated client.
const asPrismaService = (fake: FakePrismaClient): PrismaService => fake as unknown as PrismaService;

describeUsersStoreContract(
  "PrismaUsersRepository",
  () => new PrismaUsersRepository(asPrismaService(new FakePrismaClient())),
);

describeUsersStoreContract("InMemoryUsersRepository", () => new InMemoryUsersRepository());
