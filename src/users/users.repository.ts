import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { Prisma, User } from "@prisma/client";

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

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
}
