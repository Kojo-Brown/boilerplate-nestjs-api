import type { Role } from "@prisma/client";

/** A refresh token to persist, already generated and owned by `userId`. */
export interface IssueRefreshTokenData {
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
  /**
   * The family this token joins, when it replaces one that was just consumed.
   *
   * Omitted for a fresh sign-in, which starts a family of its own. Passing the
   * family the predecessor came from is what makes rotation a *chain* rather
   * than a series of unrelated credentials — and a chain is the unit a replay
   * revokes.
   *
   * Issuing into a family that has since been revoked is permitted rather than
   * refused. The check would be a read racing a write that can land either
   * side of it, and the outcome is the same and safe either way: the token is
   * refused the first time it is presented, because {@link
   * RefreshTokenStore.consume} reads the family's state under a lock.
   */
  readonly familyId?: string;
}

/**
 * The token that was claimed, together with what the caller needs to mint a
 * replacement.
 *
 * The owner's identity is returned with the claim rather than looked up
 * afterwards because a second query would be outside the transaction that made
 * the claim exclusive — and because the caller needs `familyId` to issue the
 * successor into the same chain.
 */
export interface ConsumedRefreshToken {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
  /** The token's own expiry. Whether that makes it unusable is the caller's policy. */
  readonly expiresAt: Date;
  /** The chain this token belonged to. The successor must be issued into it. */
  readonly familyId: string;
}

/**
 * A replay, and what was done about it.
 *
 * Reported once per family: the store returns this from the presentation that
 * *performed* the revocation, and answers `revoked` to every presentation
 * after it. A detection is an event, not a state — a caller that logged it as
 * a state would write one alert per request an attacker chose to send.
 */
export interface RefreshTokenReuse {
  readonly familyId: string;
  /** The account whose session this was. Not necessarily the party that replayed it. */
  readonly userId: string;
  /**
   * How many of the family's tokens were still unspent when it was revoked.
   *
   * Ordinarily 1 — the successor the legitimate client is holding, which is
   * what the revocation actually takes away. Zero means the family had already
   * rotated no further, so nothing usable was outstanding, which is worth
   * telling apart in the record.
   */
  readonly revokedTokens: number;
}

/**
 * What `consume` found. A tagged union rather than `T | null`, because the
 * three ways a token can fail now call for three different responses and
 * collapsing them loses the one that matters.
 */
export type RefreshTokenClaim =
  /** The token was live and is now spent. Mint the replacement into `familyId`. */
  | { readonly outcome: "claimed"; readonly token: ConsumedRefreshToken }
  /**
   * A spent token was presented again, and this presentation revoked its
   * family. Returned exactly once per family — see {@link RefreshTokenReuse}.
   */
  | { readonly outcome: "reused"; readonly reuse: RefreshTokenReuse }
  /**
   * The token is real, but its family is finished — revoked by a replay, or by
   * a sign-out. Nothing new was learned, so nothing is reported.
   */
  | { readonly outcome: "revoked" }
  /** No such token was ever issued, or it has been pruned. */
  | { readonly outcome: "unknown" };

/**
 * Persistence for refresh tokens.
 *
 * A port rather than direct Prisma calls in `AuthService` because `consume` has
 * an *atomicity* requirement that no signature can express and no mock will
 * accidentally satisfy — see below. Making it a port is what lets the same
 * behavioural contract run against the real adapter and the in-memory one, so
 * "at most one caller wins, and the loser is recognised as a replay" is
 * asserted rather than assumed.
 */
export interface RefreshTokenStore {
  /**
   * Persists a token, starting a family or joining the one named in `data`.
   *
   * Starting one is a single unit of work: a family with no token is a row
   * nothing can ever reach, and a token with no family would not have a chain
   * to revoke.
   */
  issue(data: IssueRefreshTokenData): Promise<void>;

  /**
   * Atomically claims the token, or reports why it could not be claimed.
   *
   * **At most one of any number of concurrent callers may be answered
   * `claimed` for the same token, and every other caller must be answered
   * `reused` or `revoked` rather than `unknown`.** This is the whole reason the
   * method exists.
   *
   * The obvious read-then-write spelling does not express it. Two requests
   * carrying the same token — a client retrying over a flaky connection, or a
   * thief racing the owner — both find the row unspent, and only whichever
   * write lands second sorts them out, by which point both have been told they
   * won. Stating the property here is what lets a contract test hold every
   * implementation to it.
   *
   * The second half of that sentence is the detection. A spent token is *kept*,
   * so presenting it again is recognisable; an implementation that deleted it
   * would answer `unknown`, which is also the answer for a token that was never
   * issued, and the one event worth acting on would be indistinguishable from a
   * typo. Recognising it is not enough on its own either: by the time a spent
   * token comes back, two parties have held it and there is no way to tell
   * which one is presenting it now — so the whole family goes, including the
   * successor the legitimate client is holding. That is the trade this makes
   * deliberately, and `docs/refresh-token-rotation.md` says what it costs.
   *
   * Expiry is deliberately *not* checked here. A store decides who gets the
   * row; whether an expired token is still acceptable is policy, and it lives
   * in `AuthService`. An expired token presented to `consume` is therefore
   * claimed and spent like any other — the row is spent either way, and a
   * rejected token left claimable would be a second chance nobody wanted to
   * give.
   */
  consume(token: string): Promise<RefreshTokenClaim>;

  /**
   * Ends the session this token belongs to.
   *
   * The *family*, not the token: signing out means the credential is finished
   * with, and a token that is finished with must not be usable if it leaked.
   * Revoking only the presented token would leave every predecessor of it
   * replayable for as long as the family lived.
   *
   * Idempotent — revoking an unknown token, or one whose family is already
   * revoked, is not an error. The rows are marked rather than deleted, so a
   * token replayed after a sign-out is still recognised as a real token rather
   * than reported as `unknown`.
   */
  revoke(token: string): Promise<void>;

  /**
   * Deletes families whose every token expired before `before`, resolving with
   * how many families went. Idempotent.
   *
   * Spent tokens are kept, which means this table only grows. Retention is the
   * price of the detection and the two are in tension: prune too eagerly and a
   * replay of a pruned token reports `unknown`, which is exactly the blindness
   * this design removes. `before` is therefore the operator's dial and not a
   * constant here — see `docs/refresh-token-rotation.md` for what to set it to.
   *
   * Scoped to families rather than tokens because a family is the unit that
   * can be reasoned about: deleting a spent token while its live successor
   * remains would leave a chain whose beginning cannot be replayed and whose
   * end can.
   */
  prune(before: Date): Promise<number>;
}

/** DI token for {@link RefreshTokenStore}. */
export const REFRESH_TOKEN_STORE = Symbol("REFRESH_TOKEN_STORE");
