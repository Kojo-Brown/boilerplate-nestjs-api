import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { lockRows } from "@/common/locking";
import type {
  ConsumedRefreshToken,
  IssueRefreshTokenData,
  RefreshTokenStore,
} from "./ports/refresh-token-store.port";

/**
 * How long `consume` will block on a token another request is already
 * consuming, before giving up.
 *
 * The holder's critical section is a locking `SELECT`, one indexed read and one
 * `DELETE` — sub-millisecond in the ordinary case — so a wait this long means
 * something is wrong (a stalled connection, a lock held across an await it
 * should not be). Failing then is better than a request thread parked
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

  async issue(data: IssueRefreshTokenData): Promise<void> {
    await this.prisma.refreshToken.create({ data });
  }

  /**
   * Claims the token under a row lock held for the life of the transaction.
   *
   * The sequence is lock → read → delete, and the order is the point. The
   * locking `SELECT` is what serialises concurrent callers; under `READ
   * COMMITTED` it re-checks its own `WHERE` after the wait, so the loser's
   * lock attempt returns no rows once the winner's `DELETE` commits, and it
   * reports "unknown token" rather than deleting a row that is already gone.
   *
   * `FOR UPDATE` rather than `FOR NO KEY UPDATE`: the row is about to be
   * deleted, and a delete needs the stronger mode. The usual argument for the
   * weaker one — not blocking inserts of children — does not apply, because
   * nothing references `refresh_tokens`.
   *
   * Locking on `token` rather than on the primary key is what makes this work
   * with one round trip: the id is not known until the row is read, so locking
   * by id would need an unlocked read first, and every caller would then race
   * between that read and the lock. `token` is unique and indexed, so it is a
   * perfectly good thing to lock by.
   */
  consume(token: string): Promise<ConsumedRefreshToken | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await lockRows(tx, {
          table: "refresh_tokens",
          keyColumn: "token",
          keys: [token],
          strength: "update",
          waitTimeoutMs: LOCK_WAIT_TIMEOUT_MS,
        });
        if (locked.length === 0) return null;

        const row = await tx.refreshToken.findUnique({
          where: { token },
          include: { user: true },
        });
        // The lock said the row was there, so this is all but unreachable; it
        // is a `null` check rather than an assertion because the alternative is
        // a `TypeError` in an auth path, and "unknown token" is the right
        // answer for a row that is not there whatever the reason.
        if (!row) return null;

        await tx.refreshToken.delete({ where: { id: row.id } });

        return {
          userId: row.user.id,
          email: row.user.email,
          role: row.user.role,
          expiresAt: row.expiresAt,
        };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * Unconditional and unlocked, deliberately.
   *
   * `deleteMany` removes the row if it is there and reports a count of zero if
   * it is not, so logout is idempotent without a read first. There is nothing
   * to serialise: two concurrent logouts of the same token both want it gone,
   * and both get their wish.
   */
  async revoke(token: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { token } });
  }
}
