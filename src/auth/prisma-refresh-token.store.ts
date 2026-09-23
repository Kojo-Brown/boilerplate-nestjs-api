import { Injectable } from "@nestjs/common";
import { Prisma, RefreshTokenRevocation } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { lockRows } from "@/common/locking";
import type {
  IssueRefreshTokenData,
  RefreshTokenClaim,
  RefreshTokenStore,
} from "./ports/refresh-token-store.port";

/**
 * How long a lock attempt will block on a row another request is already
 * holding, before giving up.
 *
 * The holder's critical section is two locking `SELECT`s, two indexed reads and
 * one `UPDATE` — sub-millisecond in the ordinary case — so a wait this long
 * means something is wrong (a stalled connection, a lock held across an await
 * it should not be). Failing then is better than a request thread parked
 * indefinitely on a credential that is single-use anyway.
 */
const LOCK_WAIT_TIMEOUT_MS = 3_000;

/**
 * Ceiling on the whole interactive transaction.
 *
 * Prisma's default is 5s, which would fire *before* the lock timeout could not
 * — but it reports as a transaction error rather than a lock one, so the more
 * specific timeout is deliberately set well below it.
 */
const TRANSACTION_TIMEOUT_MS = 5_000;

@Injectable()
export class PrismaRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One statement either way, so a family can never exist without the token
   * that is its only way in.
   *
   * The nested `create` is a single transaction in Prisma; the `familyId`
   * branch is a plain insert, and the foreign key is what refuses a family id
   * that does not exist rather than silently orphaning the token.
   */
  async issue(data: IssueRefreshTokenData): Promise<void> {
    const { token, userId, expiresAt, familyId } = data;

    if (familyId !== undefined) {
      await this.prisma.refreshToken.create({ data: { token, userId, expiresAt, familyId } });
      return;
    }

    await this.prisma.refreshTokenFamily.create({
      data: { userId, tokens: { create: { token, userId, expiresAt } } },
    });
  }

  /**
   * Claims the token under two row locks held for the life of the transaction.
   *
   * The sequence is lock token → read → lock family → decide → write, and both
   * locks are load-bearing:
   *
   * - The **token** lock is what serialises two callers presenting the *same*
   *   token. Under `READ COMMITTED` the loser's locking `SELECT` re-checks its
   *   own `WHERE` after the wait and then reads a row whose `consumedAt` the
   *   winner has just set — which is precisely the replay this method exists to
   *   recognise, arriving as a race rather than as two separate requests.
   * - The **family** lock serialises callers presenting *different* tokens of
   *   the same family, which is the other way two replays can collide. Without
   *   it, two replays could both read a live family, both decide to revoke it,
   *   and both report a first detection for one compromise.
   *
   * Always in that order, so two callers can never hold one lock each and wait
   * for the other's.
   *
   * `no-key-update` for both, and the change from `update` is deliberate: a
   * claim is now an `UPDATE` of `consumedAt` rather than the `DELETE` this used
   * to do, and neither lock's row has its key columns touched. It matters on
   * the family row, which `refresh_tokens` references — `FOR UPDATE` there
   * conflicts with the `FOR KEY SHARE` that inserting a token takes, so
   * revoking a family would block the very rotation that is issuing the
   * successor. See `RowLockStrength`.
   *
   * Locking on `token` rather than on the primary key is what makes this work
   * with one round trip: the id is not known until the row is read, so locking
   * by id would need an unlocked read first, and every caller would then race
   * between that read and the lock. `token` is unique and indexed, so it is a
   * perfectly good thing to lock by.
   */
  consume(token: string): Promise<RefreshTokenClaim> {
    return this.prisma.$transaction(
      async (tx): Promise<RefreshTokenClaim> => {
        const locked = await lockRows(tx, {
          table: "refresh_tokens",
          keyColumn: "token",
          keys: [token],
          strength: "no-key-update",
          waitTimeoutMs: LOCK_WAIT_TIMEOUT_MS,
        });
        if (locked.length === 0) return { outcome: "unknown" };

        const row = await tx.refreshToken.findUnique({
          where: { token },
          include: { user: true },
        });
        // The lock said the row was there, so this is all but unreachable; it
        // is a `null` check rather than an assertion because the alternative is
        // a `TypeError` in an auth path, and "unknown token" is the right
        // answer for a row that is not there whatever the reason.
        if (!row) return { outcome: "unknown" };

        await lockRows(tx, {
          table: "refresh_token_families",
          keyColumn: "id",
          keys: [row.familyId],
          strength: "no-key-update",
          waitTimeoutMs: LOCK_WAIT_TIMEOUT_MS,
        });
        // Read *after* the lock, never before: the whole point of waiting is
        // that whoever held it may have revoked the family in the meantime.
        const family = await tx.refreshTokenFamily.findUnique({ where: { id: row.familyId } });
        if (!family) return { outcome: "unknown" };

        const alreadyRevoked = family.revokedAt !== null;

        if (row.consumedAt !== null) {
          // A spent token, presented again. If the family is already finished
          // there is nothing left to revoke and nothing new to report — the
          // detection is an event, and this is not the presentation that
          // caused it.
          if (alreadyRevoked) return { outcome: "revoked" };
          return { outcome: "reused", reuse: await this.revokeFamily(tx, family.id, row.userId) };
        }

        if (alreadyRevoked) return { outcome: "revoked" };

        await tx.refreshToken.update({
          where: { id: row.id },
          data: { consumedAt: new Date() },
        });

        return {
          outcome: "claimed",
          token: {
            userId: row.user.id,
            email: row.user.email,
            role: row.user.role,
            expiresAt: row.expiresAt,
            familyId: row.familyId,
          },
        };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * Marks the token's family revoked.
   *
   * Unlocked and unconditional. There is nothing to serialise: two concurrent
   * sign-outs of the same session both want it gone and both get their wish,
   * and `updateMany` reports a count instead of raising, so revoking an unknown
   * token is a no-op rather than a `P2025`.
   *
   * `revokedAt: null` in the filter keeps the *first* reason and the first
   * timestamp. A sign-out arriving after a replay must not overwrite
   * `REUSE_DETECTED` with `LOGOUT` — that is the record of an attack being
   * quietly relabelled as routine.
   */
  async revoke(token: string): Promise<void> {
    await this.prisma.refreshTokenFamily.updateMany({
      where: { revokedAt: null, tokens: { some: { token } } },
      data: { revokedAt: new Date(), revokedReason: RefreshTokenRevocation.LOGOUT },
    });
  }

  /**
   * Deletes every family whose tokens have all expired before `before`.
   *
   * `every` over the relation rather than a join on the newest token: a family
   * is prunable exactly when nothing in it could still be presented, and that
   * is the same sentence. The tokens go with it through the foreign key's
   * cascade, so this is one statement and cannot leave a family half-pruned.
   */
  async prune(before: Date): Promise<number> {
    const { count } = await this.prisma.refreshTokenFamily.deleteMany({
      where: { tokens: { every: { expiresAt: { lt: before } } } },
    });
    return count;
  }

  /**
   * Kills the family and reports what it cost the legitimate holder.
   *
   * The count is taken before the write and inside the same transaction, so it
   * is the number of tokens that were genuinely live at the moment of
   * detection rather than a figure some later request could have changed.
   */
  private async revokeFamily(tx: Prisma.TransactionClient, familyId: string, userId: string) {
    const revokedTokens = await tx.refreshToken.count({
      where: { familyId, consumedAt: null },
    });

    await tx.refreshTokenFamily.update({
      where: { id: familyId },
      data: { revokedAt: new Date(), revokedReason: RefreshTokenRevocation.REUSE_DETECTED },
    });

    return { familyId, userId, revokedTokens };
  }
}
