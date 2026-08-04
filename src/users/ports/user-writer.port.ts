import type { User } from "@prisma/client";

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

  /** Rejects when no user has this id. */
  update(id: string, data: UpdateUserData): Promise<User>;

  /** Rejects when no user has this id. Resolves with the deleted row. */
  delete(id: string): Promise<User>;
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
