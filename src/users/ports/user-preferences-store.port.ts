import type { UserPreferences } from "@/users/types/user-preferences";

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
   * what `UsersService` does before calling.
   */
  getPreferences(id: string): Promise<UserPreferences>;

  /** Merges `patch` into the stored preferences. Rejects when no user has this id. */
  setPreferences(id: string, patch: Partial<UserPreferences>): Promise<UserPreferences>;
}

/** DI token for {@link UserPreferencesStore}. */
export const USER_PREFERENCES_STORE = Symbol("USER_PREFERENCES_STORE");
