import type { User } from "@prisma/client";

/**
 * Read-side port for user persistence.
 *
 * Kept separate from {@link "./user-writer.port".UserWriter} so that a
 * read-only consumer — an auth strategy resolving a token subject, a report
 * builder — depends on four methods it calls rather than on the ten the
 * storage adapter happens to expose (ISP). Widening the write side then cannot
 * break a reader, and a test double for a reader stays four stubs long.
 */
export interface UserReader {
  findById(id: string): Promise<User | null>;

  findByEmail(email: string): Promise<User | null>;

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null>;

  /**
   * Returns at most `limit + 1` rows so the caller can detect a further page
   * without a second round trip; see `buildCursorPage`.
   */
  findMany(query: UserListQuery): Promise<User[]>;
}

export interface UserListQuery {
  /** Raw (already decoded) id of the last row on the previous page. */
  readonly cursor?: string;
  readonly limit: number;
  /** Case-insensitive substring matched against name and email. */
  readonly search?: string;
}

/**
 * DI token for {@link UserReader}.
 *
 * A symbol rather than a string: two modules cannot collide on it by accident,
 * and it cannot be produced from user input. The interface itself is erased at
 * runtime, so an explicit token is the only way to inject one in Nest.
 */
export const USER_READER = Symbol("USER_READER");
