import { Role } from "@prisma/client";
import type { User, RefreshToken } from "@prisma/client";

type StoredRefreshToken = RefreshToken & { user: User };

function cuid(): string {
  return "c" + Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}

export class InMemoryPrismaService {
  readonly _users = new Map<string, User>();
  readonly _refreshTokens = new Map<string, StoredRefreshToken>();

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
          (u) =>
            u.name?.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower),
        );
      }

      let start = 0;
      if (args.cursor?.id) {
        const idx = all.findIndex((u) => u.id === args.cursor!.id);
        if (idx >= 0) start = idx + 1;
      }
      if (args.skip) start += args.skip;

      const result = args.take !== undefined ? all.slice(start, start + args.take) : all.slice(start);
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
        ...args.data,
      };
      this._users.set(user.id, user);
      return Promise.resolve(user);
    },

    update: (args: { where: { id: string }; data: Partial<User> }): Promise<User> => {
      const user = this._users.get(args.where.id);
      if (!user) return Promise.reject(new Error("Record not found"));
      const updated: User = { ...user, ...args.data, updatedAt: new Date() };
      this._users.set(args.where.id, updated);
      return Promise.resolve(updated);
    },

    delete: (args: { where: { id: string } }): Promise<User> => {
      const user = this._users.get(args.where.id);
      if (!user) return Promise.reject(new Error("Record not found"));
      this._users.delete(args.where.id);
      return Promise.resolve(user);
    },
  };

  readonly refreshToken = {
    create: (args: {
      data: { token: string; userId: string; expiresAt: Date };
    }): Promise<RefreshToken> => {
      const user = this._users.get(args.data.userId);
      if (!user) return Promise.reject(new Error("User not found"));
      const rt: StoredRefreshToken = {
        id: cuid(),
        token: args.data.token,
        userId: args.data.userId,
        expiresAt: args.data.expiresAt,
        createdAt: new Date(),
        user,
      };
      this._refreshTokens.set(args.data.token, rt);
      return Promise.resolve(rt);
    },

    findUnique: (args: {
      where: { token?: string; id?: string };
      include?: { user?: boolean };
    }): Promise<StoredRefreshToken | null> => {
      if (args.where.token) {
        return Promise.resolve(this._refreshTokens.get(args.where.token) ?? null);
      }
      if (args.where.id) {
        for (const rt of this._refreshTokens.values()) {
          if (rt.id === args.where.id) return Promise.resolve(rt);
        }
      }
      return Promise.resolve(null);
    },

    delete: (args: { where: { id: string } }): Promise<RefreshToken> => {
      for (const [key, rt] of this._refreshTokens.entries()) {
        if (rt.id === args.where.id) {
          this._refreshTokens.delete(key);
          return Promise.resolve(rt);
        }
      }
      return Promise.reject(new Error("Record not found"));
    },

    deleteMany: (args: { where: { token?: string } }): Promise<{ count: number }> => {
      if (args.where.token !== undefined) {
        const existed = this._refreshTokens.delete(args.where.token);
        return Promise.resolve({ count: existed ? 1 : 0 });
      }
      return Promise.resolve({ count: 0 });
    },
  };

  withExtensions() {
    return {
      user: {
        getPreferences: (id: string) => {
          const user = this._users.get(id);
          if (!user) return Promise.reject(new Error("User not found"));
          const stored = user.preferences as Record<string, unknown> | null;
          return Promise.resolve({
            theme: "system",
            language: "en",
            emailNotifications: true,
            ...(stored ?? {}),
          });
        },
        setPreferences: (id: string, patch: Record<string, unknown>) => {
          const user = this._users.get(id);
          if (!user) return Promise.reject(new Error("User not found"));
          const current = { theme: "system", language: "en", emailNotifications: true };
          const updated = { ...current, ...patch };
          this._users.set(id, { ...user, preferences: updated as unknown as User["preferences"], updatedAt: new Date() });
          return Promise.resolve(updated);
        },
      },
    };
  }

  $connect = () => Promise.resolve();
  $disconnect = () => Promise.resolve();

  reset() {
    this._users.clear();
    this._refreshTokens.clear();
  }
}
