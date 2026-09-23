-- Refresh-token families, and spent tokens that survive being spent.
--
-- `refresh_tokens` rows used to be deleted on rotation. They are now marked
-- `consumedAt` and kept, because a deleted token replays as "unknown" — which
-- is what a typo looks like too, so the one event worth acting on was being
-- thrown away. See docs/refresh-token-rotation.md.

-- CreateEnum
CREATE TYPE "RefreshTokenRevocation" AS ENUM ('REUSE_DETECTED', 'LOGOUT');

-- CreateTable
CREATE TABLE "refresh_token_families" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "RefreshTokenRevocation",

    CONSTRAINT "refresh_token_families_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refresh_token_families_userId_revokedAt_idx" ON "refresh_token_families"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "refresh_token_families" ADD CONSTRAINT "refresh_token_families_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "familyId" TEXT,
                              ADD COLUMN "consumedAt" TIMESTAMP(3);

-- Backfill: every token that exists today is live and unrotated, so each one
-- becomes a family of its own. Reusing the token's own id as the family id is
-- safe — it is a cuid from a different table, and the column is only unique
-- within `refresh_token_families` — and it makes the backfill two statements
-- with no join and no generated keys.
INSERT INTO "refresh_token_families" ("id", "userId", "createdAt")
SELECT "id", "userId", "createdAt" FROM "refresh_tokens";

UPDATE "refresh_tokens" SET "familyId" = "id";

-- Only now can the column be NOT NULL: doing it in the ALTER above would fail
-- on any deployment that has a single row in this table.
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "refresh_token_families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
