import type { Role } from "@prisma/client";
import type { ConsumedRefreshToken, IssueRefreshTokenData, RefreshTokenStore } from "@/auth/ports";

interface StoredToken {
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

/** The owner details `consume` returns, as the store's user source knows them. */
export interface TokenOwner {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
}

/**
 * In-memory implementation of {@link RefreshTokenStore}, for tests that care
 * about `AuthService`'s behaviour rather than about SQL.
 *
 * Owners are resolved through a callback rather than registered here, because
 * the real adapter resolves them through a join (`include: { user: true }`) and
 * a store that kept its own copy would happily hand out an email the users
 * table no longer has. Pointing the callback at whatever holds the users keeps
 * the two in step — including the cascade: a user that has gone makes their
 * tokens unclaimable, exactly as the foreign key enforces in Postgres.
 *
 * The interesting part is that `consume` really is mutually exclusive rather
 * than merely looking like it. A `Map` alone would not be: `consume` is
 * `async`, so two callers can interleave at any `await` between the lookup and
 * the delete, and a double that let both win would make the contract's
 * concurrency assertion pass against Postgres and mean nothing here — exactly
 * the dishonest-double failure `users-store.contract.spec.ts` exists to
 * prevent.
 *
 * So claims are serialised through a per-token promise chain. That is the same
 * trick `InMemoryIdempotencyStore` uses, with the same caveat: it holds within
 * one process only. Two replicas sharing this store would each keep their own
 * chain and both callers would win. It lives in `test-utils` for that reason
 * and is never wired into a running application.
 */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  /**
   * Tail of the claim chain per token — the in-process stand-in for a row lock.
   *
   * Keyed by token and dropped once the chain drains, so a store that sees a
   * fresh token on every login does not accumulate one settled promise per
   * token it has ever been shown.
   */
  private readonly claims = new Map<string, Promise<unknown>>();

  constructor(private readonly resolveOwner: (userId: string) => TokenOwner | undefined) {}

  issue(data: IssueRefreshTokenData): Promise<void> {
    this.tokens.set(data.token, {
      token: data.token,
      userId: data.userId,
      expiresAt: data.expiresAt,
    });
    return Promise.resolve();
  }

  consume(token: string): Promise<ConsumedRefreshToken | null> {
    return this.serialise(token, () => {
      const stored = this.tokens.get(token);
      if (!stored) return Promise.resolve(null);

      const owner = this.resolveOwner(stored.userId);
      if (!owner) {
        // The foreign key cascades, so Postgres cannot hold an orphaned token
        // at all. Dropping it here reproduces the outcome.
        this.tokens.delete(token);
        return Promise.resolve(null);
      }

      this.tokens.delete(token);
      return Promise.resolve({
        userId: owner.id,
        email: owner.email,
        role: owner.role,
        expiresAt: stored.expiresAt,
      });
    });
  }

  revoke(token: string): Promise<void> {
    this.tokens.delete(token);
    return Promise.resolve();
  }

  /** Test helper: is this token still claimable? */
  has(token: string): boolean {
    return this.tokens.has(token);
  }

  reset(): void {
    this.tokens.clear();
    this.claims.clear();
  }

  /**
   * Runs `work` after every claim already queued for this token has settled.
   *
   * What is stored as the chain tail is a continuation that swallows the
   * outcome, not the caller's own promise. Two reasons: a rejected claim must
   * not poison the ones queued behind it — a rolled-back transaction releases
   * its lock, it does not fail every later waiter — and an unobserved rejection
   * parked in the map would surface as an unhandled-rejection warning.
   */
  private serialise<T>(token: string, work: () => Promise<T>): Promise<T> {
    const previous = this.claims.get(token) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.claims.set(token, settled);
    void settled.then(() => {
      if (this.claims.get(token) === settled) this.claims.delete(token);
    });
    return result;
  }
}
