import type { User } from "@prisma/client";
import type { ExpectedVersion } from "@/common/concurrency";

/**
 * Write-side port for user persistence.
 *
 * The payload types are owned by this module rather than re-exported from
 * `Prisma.UserCreateInput` / `Prisma.UserUpdateInput` (DIP): the policy layer
 * should not have to speak Prisma's nested-write dialect, and an adapter
 * backed by something other than Prisma can satisfy this port without
 * pretending to accept relation writes it has no way to perform.
 */
export interface UserWriter {
  create(data: CreateUserData): Promise<User>;

  /**
   * Rejects when no user has this id, and with `VersionConflictError` when the
   * row's version does not satisfy `expected`.
   *
   * `expected` is required rather than defaulted to unconditional: a forgotten
   * argument would silently reopen the lost-update window at that one call
   * site, and nothing in a review or a type check would show it. Writers that
   * genuinely have no version to check pass `UNCONDITIONAL`, which says so.
   *
   * Every successful write increments the version, conditional or not — a row
   * that could be changed without moving its validator would hand out `ETag`s
   * that outlive the state they describe.
   */
  update(id: string, data: UpdateUserData, expected: ExpectedVersion): Promise<User>;

  /**
   * Rejects when no user has this id, and with `VersionConflictError` when the
   * row's version does not satisfy `expected`. Resolves with the deleted row.
   */
  delete(id: string, expected: ExpectedVersion): Promise<User>;
}

export interface CreateUserData {
  readonly email: string;
  /** Already hashed by the caller — the adapter never hashes. */
  readonly password?: string;
  readonly name?: string;
  readonly provider?: string;
  readonly providerAccountId?: string;
}

export interface UpdateUserData {
  readonly name?: string;
  readonly provider?: string;
  readonly providerAccountId?: string;
  /** Object key in the storage bucket, not a URL. */
  readonly avatarUrl?: string;
}

/** DI token for {@link UserWriter}. */
export const USER_WRITER = Symbol("USER_WRITER");
