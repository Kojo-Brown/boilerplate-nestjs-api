import { Injectable } from "@nestjs/common";
import { PrismaService, ExtendedPrismaClient } from "@/common/prisma/prisma.service";
import type { Prisma, User } from "@prisma/client";
import type { UserPreferences } from "@/users/types/user-preferences";

@Injectable()
export class UsersRepository {
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

  findMany(args: { cursor?: string; limit: number; search?: string }): Promise<User[]> {
    return this.prisma.user.findMany({
      take: args.limit + 1,
      cursor: args.cursor ? { id: args.cursor } : undefined,
      skip: args.cursor ? 1 : 0,
      orderBy: { createdAt: "asc" },
      where: args.search
        ? {
            OR: [
              { name: { contains: args.search, mode: "insensitive" } },
              { email: { contains: args.search, mode: "insensitive" } },
            ],
          }
        : undefined,
    });
  }

  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
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
