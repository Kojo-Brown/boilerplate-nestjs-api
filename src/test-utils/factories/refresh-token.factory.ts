import { faker } from "@faker-js/faker";
import type { RefreshToken } from "@prisma/client";

interface RefreshTokenCreateData {
  token: string;
  userId: string;
  expiresAt: Date;
}

interface PrismaRefreshTokenDelegate {
  create(args: { data: RefreshTokenCreateData }): Promise<RefreshToken>;
}

interface RefreshTokenPrismaClient {
  refreshToken: PrismaRefreshTokenDelegate;
}

function randomCuid(): string {
  return "c" + Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}

export interface RefreshTokenOverrides {
  token?: string;
  userId?: string;
  expiresAt?: Date;
  id?: string;
  createdAt?: Date;
}

export function buildRefreshToken(
  userId: string,
  overrides: RefreshTokenOverrides = {},
): RefreshToken {
  return {
    id: randomCuid(),
    token: faker.string.uuid(),
    userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

export function buildExpiredRefreshToken(
  userId: string,
  overrides: RefreshTokenOverrides = {},
): RefreshToken {
  return buildRefreshToken(userId, {
    expiresAt: new Date(Date.now() - 1000),
    ...overrides,
  });
}

export async function createRefreshToken(
  prisma: RefreshTokenPrismaClient,
  userId: string,
  overrides: RefreshTokenOverrides = {},
): Promise<RefreshToken> {
  const { id: _id, createdAt: _c, ...data } = buildRefreshToken(userId, overrides);
  return prisma.refreshToken.create({ data });
}
