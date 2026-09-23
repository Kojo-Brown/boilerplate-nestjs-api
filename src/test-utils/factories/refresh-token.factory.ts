import { faker } from "@faker-js/faker";
import type { RefreshToken } from "@prisma/client";

interface RefreshTokenCreateData {
  token: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface RefreshTokenFamilyDelegate {
  create(args: { data: { userId: string } }): Promise<{ id: string }>;
}

interface PrismaRefreshTokenDelegate {
  create(args: { data: RefreshTokenCreateData }): Promise<RefreshToken>;
}

interface RefreshTokenPrismaClient {
  refreshToken: PrismaRefreshTokenDelegate;
  refreshTokenFamily: RefreshTokenFamilyDelegate;
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
  familyId?: string;
  /** Set it to build a token that has already been rotated away — a replay. */
  consumedAt?: Date | null;
}

export function buildRefreshToken(
  userId: string,
  overrides: RefreshTokenOverrides = {},
): RefreshToken {
  return {
    id: randomCuid(),
    token: faker.string.uuid(),
    userId,
    // A family of its own by default: a built token stands for a fresh
    // sign-in, and two unrelated fixtures sharing a family would make a replay
    // of one revoke the other.
    familyId: randomCuid(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    consumedAt: null,
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
  // The family comes first, and is real: a token whose `familyId` names nothing
  // is refused by the foreign key at the call site, with a constraint name
  // instead of an explanation.
  const familyId =
    overrides.familyId ?? (await prisma.refreshTokenFamily.create({ data: { userId } })).id;
  return prisma.refreshToken.create({ data: { ...data, familyId } });
}
