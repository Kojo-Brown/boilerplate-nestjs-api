import { faker } from "@faker-js/faker";
import { Role } from "@prisma/client";
import type { User } from "@prisma/client";

interface PrismaUserDelegate {
  create(args: { data: Partial<User> & { email: string } }): Promise<User>;
}

interface UserPrismaClient {
  user: PrismaUserDelegate;
}

function randomCuid(): string {
  return "c" + Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}

export function buildUser(overrides: Partial<User> = {}): User {
  const now = new Date();
  return {
    id: randomCuid(),
    email: faker.internet.email(),
    name: faker.person.fullName(),
    password: "$argon2id$v=19$m=65536$fakehash",
    role: Role.USER,
    provider: null,
    providerAccountId: null,
    avatarUrl: null,
    preferences: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function buildAdminUser(overrides: Partial<User> = {}): User {
  return buildUser({ role: Role.ADMIN, ...overrides });
}

export function buildOAuthUser(
  provider: string,
  overrides: Partial<User> = {},
): User {
  return buildUser({
    password: null,
    provider,
    providerAccountId: faker.string.uuid(),
    ...overrides,
  });
}

export async function createUser(
  prisma: UserPrismaClient,
  overrides: Partial<User> = {},
): Promise<User> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...data } = buildUser(overrides);
  return prisma.user.create({ data: data as Partial<User> & { email: string } });
}

export async function createAdminUser(
  prisma: UserPrismaClient,
  overrides: Partial<User> = {},
): Promise<User> {
  return createUser(prisma, { role: Role.ADMIN, ...overrides });
}
