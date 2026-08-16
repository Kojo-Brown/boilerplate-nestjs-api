import type { Role } from "@prisma/client";

/** A refresh token to persist, already generated and owned by `userId`. */
export interface IssueRefreshTokenData {
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

/**
 * The token that was claimed, together with what the caller needs to mint a
 * replacement.
 *
 * The owner's identity is returned with the claim rather than looked up
 * afterwards because the row is gone by then — and because a second query would
 * be outside the transaction that made the claim exclusive.
 */
export interface ConsumedRefreshToken {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
  /** The token's own expiry. Whether that makes it unusable is the caller's policy. */
  readonly expiresAt: Date;
}

/**
 * Persistence for refresh tokens.
 *
 * A port rather than direct Prisma calls in `AuthService` because `consume` has
 * an *atomicity* requirement that no signature can express and no mock will
 * accidentally satisfy — see below. Making it a port is what lets the same
 * behavioural contract run against the real adapter and the in-memory one, so
 * "at most one caller wins" is asserted rather than assumed.
 */
export interface RefreshTokenStore {
  issue(data: IssueRefreshTokenData): Promise<void>;

  /**
   * Atomically claims and removes the token, resolving with its owner, or with
   * `null` if no such token exists.
   *
   * **At most one of any number of concurrent callers may receive a non-null
   * result for the same token.** This is the whole reason the method exists.
   *
   * The obvious read-then-delete spelling does not express it. Two requests
   * carrying the same token both find the row — verified against Postgres, not
   * assumed — and only the `DELETE` sorts them out, by failing on a row that is
   * already gone. That is single-use by accident rather than by design: the
   * invariant lives in whichever statement happens to be last, so the loser
   * surfaces as a driver error rather than as a rejected credential, and
   * spelling the delete a shade differently (`deleteMany`, which reports a
   * count instead of raising) turns one single-use token into two live token
   * families with nothing to notice. Stating the property here is what lets a
   * contract test hold every implementation to it.
   *
   * Expiry is deliberately *not* checked here. A store decides who gets the
   * row; whether an expired token is still acceptable is policy, and it lives
   * in `AuthService`. An expired token presented to `consume` is therefore
   * claimed and removed like any other — which is the behaviour worth having:
   * the row is spent either way, and a rejected token that stays in the table
   * is just litter.
   */
  consume(token: string): Promise<ConsumedRefreshToken | null>;

  /** Removes the token if present. Idempotent — revoking an unknown token is not an error. */
  revoke(token: string): Promise<void>;
}

/** DI token for {@link RefreshTokenStore}. */
export const REFRESH_TOKEN_STORE = Symbol("REFRESH_TOKEN_STORE");
