import { Inject, Injectable, NotFoundException, PreconditionFailedException } from "@nestjs/common";
import { CacheService } from "@/common/cache";
import {
  VersionConflictError,
  describeMismatch,
  isSatisfiedBy,
  requireConditional,
} from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import type { TransactionContext, TransactionRunner } from "@/common/prisma/transaction.port";
import { TransactionalOutbox } from "@/outbox";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import type { User } from "@prisma/client";
import {
  USER_PREFERENCES_STORE,
  USER_READER,
  USER_WRITER,
  type CreateUserData,
  type PreferencesWriteResult,
  type UpdateUserData,
  type UserPreferencesStore,
  type UserReader,
  type UserWriter,
} from "./ports";
import { UserAccessPolicy, type RequesterIdentity } from "./users.access-policy";
import type { UpdateUserDto } from "./dto/update-user.dto";
import type { ListUsersQueryDto } from "./dto/list-users-query.dto";
import type { UpdateUserPreferencesDto } from "./dto/update-user-preferences.dto";

export const USERS_LIST_CACHE_KEY = "v1:users:list";
export const userCacheKey = (id: string) => `v1:users:${id}`;

/**
 * Application service for the users module.
 *
 * Depends on the three storage ports rather than on a concrete repository
 * (DIP) and on `UserAccessPolicy` for ownership decisions (SRP). Nothing here
 * knows that the store is Prisma, which is why the contract-tested in-memory
 * implementation can be dropped in unchanged.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(USER_READER) private readonly reader: UserReader,
    @Inject(USER_WRITER) private readonly writer: UserWriter,
    @Inject(USER_PREFERENCES_STORE) private readonly preferences: UserPreferencesStore,
    private readonly cache: CacheService,
    private readonly policy: UserAccessPolicy,
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    private readonly outbox: TransactionalOutbox,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.reader.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.reader.findByEmail(email);
  }

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    return this.reader.findByProviderAccount(provider, providerAccountId);
  }

  async listUsers(query: ListUsersQueryDto): Promise<CursorPage<User>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.reader.findMany({
      cursor,
      limit: query.limit,
      search: query.search,
    });
    return buildCursorPage(rows, query.limit);
  }

  /**
   * `tx` enrols the insert in a unit of work the caller already opened — which
   * is what `AuthService` needs in order to commit the row and the
   * `user.registered` event together.
   */
  create(data: CreateUserData, tx?: TransactionContext): Promise<User> {
    return this.writer.create(data, tx);
  }

  /**
   * Applies `data` only if the row still satisfies `expected`.
   *
   * Does not demand a precondition — this is the entry point for internal
   * callers with no version to check, which pass `UNCONDITIONAL` and say so at
   * the call site. Anything acting on behalf of a client uses {@link updateSelf}.
   */
  async update(id: string, data: UpdateUserData, expected: ExpectedVersion): Promise<User> {
    await this.findById(id);
    return this.write(id, data, expected);
  }

  async updateSelf(
    requester: RequesterIdentity,
    targetId: string,
    dto: UpdateUserDto,
    expected: ExpectedVersion,
  ): Promise<User> {
    this.policy.assertCanAct(requester, targetId, "update:profile");
    await this.assertPrecondition(targetId, expected);
    return this.write(targetId, dto, expected);
  }

  /**
   * The caller has already checked ownership and the precondition — the upload
   * had to happen before the row could be touched, and neither check is worth
   * repeating against a row that has not moved since.
   */
  async updateAvatar(id: string, avatarUrl: string, expected: ExpectedVersion): Promise<User> {
    return this.update(id, { avatarUrl }, expected);
  }

  /**
   * Deletes the row and announces it, atomically.
   *
   * The event is staged in the same transaction as the delete rather than
   * published after it, so the two outcomes a bare emitter allows are gone: a
   * user deleted with nobody told, and a `user.deleted` describing a row that
   * is still there because the delete rolled back.
   *
   * The cache is invalidated *inside* the unit of work, which is not where it
   * belongs on first reading. It is deliberate: the relay may publish the
   * moment the transaction commits, and a subscriber reading back through this
   * service must not find the deleted row still cached. Invalidating early is
   * safe in the other direction — a transaction that then rolls back leaves the
   * cache merely cold, and the next read repopulates it from a row that does
   * still exist.
   */
  async remove(id: string, expected: ExpectedVersion): Promise<void> {
    const user = await this.assertPrecondition(id, expected);
    await this.transactions.run(async (tx) => {
      await this.conditionally(() => this.writer.delete(id, expected, tx));
      await this.invalidateUserCache(id);
      // The address travels on the event because nothing can look it up once
      // this commits.
      await this.outbox.stage(tx, "user.deleted", { userId: id, email: user.email });
    });
  }

  /**
   * Returns the preferences together with the version they were read at, so
   * the endpoint can emit an `ETag` the caller can write back against.
   *
   * The version comes from the user row rather than from the preferences store,
   * which has none of its own: they are a projection of a JSON column on that
   * row, and the row's counter is the only thing that moves when they change.
   */
  async getPreferences(
    requester: RequesterIdentity,
    userId: string,
  ): Promise<PreferencesWriteResult> {
    this.policy.assertCanAct(requester, userId, "read:preferences");
    const user = await this.findById(userId);
    const preferences = await this.preferences.getPreferences(userId);
    return { preferences, version: user.version };
  }

  /**
   * Runs every precondition on a conditional write, and resolves with the row.
   *
   * The order is the point, and it is RFC 9110 §13.2.1's: 404 for a resource
   * that is not there, then 428 for a caller that named no version, then 412
   * for one whose version has been overtaken. Answering 428 to a request for a
   * row that does not exist would send the client to fetch an `ETag` it can
   * never obtain, and answering 412 before 428 would tell a client that sent no
   * validator at all that the one it sent was stale.
   *
   * The 412 here is a fast check, not the guarantee: the row can still move
   * between this read and the write, which is why every write also carries the
   * predicate. What this buys is that an expensive side effect — an S3 upload —
   * is not spent on a request that has already lost.
   */
  async assertPrecondition(id: string, expected: ExpectedVersion): Promise<User> {
    const user = await this.findById(id);
    requireConditional(expected);
    if (!isSatisfiedBy(expected, user.version)) {
      throw new PreconditionFailedException(describeMismatch(expected, user.version));
    }
    return user;
  }

  /** The write itself, once every precondition has been cleared. */
  private async write(id: string, data: UpdateUserData, expected: ExpectedVersion): Promise<User> {
    const updated = await this.conditionally(() => this.writer.update(id, data, expected));
    await this.invalidateUserCache(id);
    return updated;
  }

  async updatePreferences(
    requester: RequesterIdentity,
    userId: string,
    dto: UpdateUserPreferencesDto,
    expected: ExpectedVersion,
  ): Promise<PreferencesWriteResult> {
    this.policy.assertCanAct(requester, userId, "update:preferences");
    await this.assertPrecondition(userId, expected);
    const written = await this.conditionally(() =>
      this.preferences.setPreferences(userId, dto, expected),
    );
    await this.cache.del(`${userCacheKey(userId)}:prefs`);
    // Preferences are stored on the user row, so writing them moved the row's
    // version — the cached representation of the user is now stale too.
    await this.invalidateUserCache(userId);
    return written;
  }

  /**
   * Runs a conditional write, translating a storage-layer conflict into 412.
   *
   * The store raises `VersionConflictError`, which names no status because it
   * is not an HTTP concern where it is thrown. This is the boundary where it
   * becomes one, so the mapping lives here once rather than in each of the four
   * endpoints that can hit it.
   */
  private async conditionally<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof VersionConflictError) {
        throw new PreconditionFailedException(error.message);
      }
      throw error;
    }
  }

  private invalidateUserCache(id: string): Promise<void> {
    return this.cache.delMany([userCacheKey(id), USERS_LIST_CACHE_KEY]);
  }
}
