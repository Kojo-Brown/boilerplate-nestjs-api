import type { ReadonlyUserPreferences, UserPreferences } from "@/users/types/user-preferences";
import type { ExpectedVersion } from "@/common/concurrency";

/**
 * Preferences port.
 *
 * Split out from the reader and the writer because it is the one part of user
 * persistence that is not a row operation: it reads and merges a JSON column
 * through a Prisma client extension, has its own defaulting rules, and is
 * consumed by exactly two endpoints. Folding it into the writer would force
 * every write-side double to stub two methods that most callers never touch.
 */
export interface UserPreferencesStore {
  /**
   * Stored values merged over `DEFAULT_USER_PREFERENCES`.
   *
   * Resolves with the defaults for an unknown id rather than rejecting — an
   * absent row and an unset column are the same "nothing stored yet" to this
   * port. Callers that need a 404 must check existence themselves, which is
   * what `GetUserPreferencesHandler` does before calling.
   *
   * The result is read-only because it may be the store's own value: with no
   * preferences stored this resolves with `DEFAULT_USER_PREFERENCES` itself.
   */
  getPreferences(id: string): Promise<ReadonlyUserPreferences>;

  /**
   * Merges `patch` into the stored preferences. Rejects when no user has this
   * id, and with `VersionConflictError` when the row's version does not satisfy
   * `expected`.
   *
   * Preferences live on the user row, so writing them moves the *user's*
   * version — one validator covers the row and every projection of it. That is
   * conservative: a profile rename will fail an `If-Match` on preferences that
   * did not really conflict. The alternative, a second counter for the JSON
   * column, buys fewer false conflicts at the cost of two validators for one
   * row, which is how a client ends up sending the wrong one.
   *
   * Returns the new version as well as the merged value: this is a
   * read-modify-write, so the caller cannot compute the resulting version from
   * what it knew going in.
   */
  setPreferences(
    id: string,
    patch: Partial<UserPreferences>,
    expected: ExpectedVersion,
  ): Promise<PreferencesWriteResult>;
}

export interface PreferencesWriteResult {
  readonly preferences: ReadonlyUserPreferences;
  /** The user row's version *after* the write. */
  readonly version: number;
}

/** DI token for {@link UserPreferencesStore}. */
export const USER_PREFERENCES_STORE = Symbol("USER_PREFERENCES_STORE");
