import { Injectable } from "@nestjs/common";
import { PrismaService, ExtendedPrismaClient } from "@/common/prisma/prisma.service";
import type { User } from "@prisma/client";
import type { UserPreferences } from "@/users/types/user-preferences";
import type {
  CreateUserData,
  UpdateUserData,
  UserListQuery,
  UserPreferencesStore,
  UserReader,
  UserWriter,
} from "./ports";

/**
 * The Prisma-backed adapter for the three user ports.
 *
 * One class implements all three: they are split for the *consumers*' benefit,
 * not to force three adapters on anyone who only has one database. The module
 * binds each token to this class with `useExisting`, so all three tokens
 * resolve to a single instance.
 */
@Injectable()
export class PrismaUsersRepository implements UserReader, UserWriter, UserPreferencesStore {
  private readonly extended: ExtendedPrismaClient;

  constructor(private readonly prisma: PrismaService) {
    this.extended = prisma.withExtensions();
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { provider, providerAccountId } });
  }

  findMany(query: UserListQuery): Promise<User[]> {
    return this.prisma.user.findMany({
      take: query.limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      orderBy: { createdAt: "asc" },
      where: query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : undefined,
    });
  }

  create(data: CreateUserData): Promise<User> {
    return this.prisma.user.create({ data });
  }

  update(id: string, data: UpdateUserData): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  delete(id: string): Promise<User> {
    return this.prisma.user.delete({ where: { id } });
  }

  getPreferences(id: string): Promise<UserPreferences> {
    return this.extended.user.getPreferences(id);
  }

  setPreferences(id: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
    return this.extended.user.setPreferences(id, patch);
  }
}
