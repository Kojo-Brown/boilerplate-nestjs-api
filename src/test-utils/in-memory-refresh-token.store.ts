import type { Role } from "@prisma/client";
import type {
  IssueRefreshTokenData,
  RefreshTokenClaim,
  RefreshTokenReuse,
  RefreshTokenStore,
} from "@/auth/ports";

interface StoredToken {
  readonly token: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  consumedAt: Date | null;
}

interface StoredFamily {
  readonly id: string;
  readonly userId: string;
  revokedAt: Date | null;
  revokedReason: "REUSE_DETECTED" | "LOGOUT" | null;
}

/** The owner details a claim returns, as the store's user source knows them. */
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
 * the write, and a double that let both win would make the contract's
 * concurrency assertion pass against Postgres and mean nothing here — exactly
 * the dishonest-double failure `users-store.contract.spec.ts` exists to
 * prevent.
 *
 * So claims are serialised through a per-*family* promise chain. The adapter
 * locks the token row and then the family row, and of the two it is the family
 * that decides the outcome: a chain keyed on the token alone would let two
 * replays of two different tokens in one family both find it live and both
 * report a first detection, which is the bug the family lock exists to
 * prevent. Same trick as `InMemoryIdempotencyStore`, with the same caveat: it
 * holds within one process only. Two replicas sharing this store would each
 * keep their own chain and both callers would win. It lives in `test-utils`
 * for that reason and is never wired into a running application.
 */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  private readonly families = new Map<string, StoredFamily>();

  /**
   * Tail of the claim chain per family — the in-process stand-in for the row
   * locks.
   *
   * Dropped once the chain drains, so a store that sees a fresh family on every
   * login does not accumulate one settled promise per sign-in it has ever seen.
   */
  private readonly claims = new Map<string, Promise<unknown>>();

  private sequence = 0;

  constructor(private readonly resolveOwner: (userId: string) => TokenOwner | undefined) {}

  issue(data: IssueRefreshTokenData): Promise<void> {
    const familyId = data.familyId ?? this.nextFamilyId();
    if (!this.families.has(familyId)) {
      this.families.set(familyId, {
        id: familyId,
        userId: data.userId,
        revokedAt: null,
        revokedReason: null,
      });
    }
    this.tokens.set(data.token, {
      token: data.token,
      userId: data.userId,
      familyId,
      expiresAt: data.expiresAt,
      consumedAt: null,
    });
    return Promise.resolve();
  }

  consume(token: string): Promise<RefreshTokenClaim> {
    const stored = this.tokens.get(token);
    // Serialised on the family the token is *currently* known to belong to.
    // Read before the chain rather than inside it because the family a token
    // belongs to never changes; only its state does, and that is read again
    // inside the critical section.
    return this.serialise(stored?.familyId ?? `unknown:${token}`, () =>
      Promise.resolve(this.claim(token)),
    );
  }

  revoke(token: string): Promise<void> {
    const stored = this.tokens.get(token);
    if (!stored) return Promise.resolve();
    const family = this.families.get(stored.familyId);
    // First reason wins, as in the adapter: a sign-out after a replay must not
    // relabel the attack as routine.
    if (family && family.revokedAt === null) {
      family.revokedAt = new Date();
      family.revokedReason = "LOGOUT";
    }
    return Promise.resolve();
  }

  prune(before: Date): Promise<number> {
    let pruned = 0;
    for (const family of [...this.families.values()]) {
      const tokens = [...this.tokens.values()].filter((entry) => entry.familyId === family.id);
      if (tokens.some((entry) => entry.expiresAt.getTime() >= before.getTime())) continue;
      for (const entry of tokens) this.tokens.delete(entry.token);
      this.families.delete(family.id);
      pruned += 1;
    }
    return Promise.resolve(pruned);
  }

  /** Test helper: is this token still claimable? */
  has(token: string): boolean {
    const stored = this.tokens.get(token);
    if (!stored || stored.consumedAt !== null) return false;
    return this.families.get(stored.familyId)?.revokedAt === null;
  }

  /** Test helper: why a family was revoked, or null while it is live. */
  revocationOf(token: string): "REUSE_DETECTED" | "LOGOUT" | null {
    const stored = this.tokens.get(token);
    if (!stored) return null;
    return this.families.get(stored.familyId)?.revokedReason ?? null;
  }

  reset(): void {
    this.tokens.clear();
    this.families.clear();
    this.claims.clear();
  }

  /** The decision, made all at once so nothing can interleave inside it. */
  private claim(token: string): RefreshTokenClaim {
    const stored = this.tokens.get(token);
    if (!stored) return { outcome: "unknown" };

    const owner = this.resolveOwner(stored.userId);
    if (!owner) {
      // The foreign key cascades, so Postgres cannot hold an orphaned token at
      // all — nor the family it belonged to. Dropping both reproduces that.
      this.dropFamily(stored.familyId);
      return { outcome: "unknown" };
    }

    const family = this.families.get(stored.familyId);
    if (!family) return { outcome: "unknown" };
    const alreadyRevoked = family.revokedAt !== null;

    if (stored.consumedAt !== null) {
      if (alreadyRevoked) return { outcome: "revoked" };
      return { outcome: "reused", reuse: this.revokeFamily(family) };
    }

    if (alreadyRevoked) return { outcome: "revoked" };

    stored.consumedAt = new Date();
    return {
      outcome: "claimed",
      token: {
        userId: owner.id,
        email: owner.email,
        role: owner.role,
        expiresAt: stored.expiresAt,
        familyId: stored.familyId,
      },
    };
  }

  private revokeFamily(family: StoredFamily): RefreshTokenReuse {
    const revokedTokens = [...this.tokens.values()].filter(
      (entry) => entry.familyId === family.id && entry.consumedAt === null,
    ).length;
    family.revokedAt = new Date();
    family.revokedReason = "REUSE_DETECTED";
    return { familyId: family.id, userId: family.userId, revokedTokens };
  }

  private dropFamily(familyId: string): void {
    for (const entry of [...this.tokens.values()]) {
      if (entry.familyId === familyId) this.tokens.delete(entry.token);
    }
    this.families.delete(familyId);
  }

  private nextFamilyId(): string {
    this.sequence += 1;
    return `family-${this.sequence}`;
  }

  /**
   * Runs `work` after every claim already queued for this family has settled.
   *
   * What is stored as the chain tail is a continuation that swallows the
   * outcome, not the caller's own promise. Two reasons: a rejected claim must
   * not poison the ones queued behind it — a rolled-back transaction releases
   * its lock, it does not fail every later waiter — and an unobserved rejection
   * parked in the map would surface as an unhandled-rejection warning.
   */
  private serialise<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.claims.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.claims.set(key, settled);
    void settled.then(() => {
      if (this.claims.get(key) === settled) this.claims.delete(key);
    });
    return result;
  }
}
