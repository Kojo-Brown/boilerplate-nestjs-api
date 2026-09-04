import { Inject, Injectable, PreconditionFailedException } from "@nestjs/common";
import {
  VersionConflictError,
  describeMismatch,
  isSatisfiedBy,
  requireConditional,
} from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { User } from "@prisma/client";
import {
  USER_READER,
  USER_WRITER,
  type UpdateUserData,
  type UserReader,
  type UserWriter,
} from "../ports";
import { requireUser } from "../require-user";
import { UsersReadModelCache } from "../read/users-read-model.cache";

/**
 * The machinery every user write shares: preconditions, conflict translation,
 * and the eviction that has to follow a successful write.
 *
 * Not a service in the sense the deleted `UsersService` was. It holds no
 * orchestration and no policy — no transaction is opened here, no event staged,
 * no ownership decided — so a command handler still reads as the whole story of
 * its command. What it does hold is the three rules that were identical in six
 * places and dangerous to get subtly different: what order preconditions are
 * evaluated in, what a storage-level version conflict becomes at the HTTP edge,
 * and the fact that a write is not finished until the read model has been told.
 */
@Injectable()
export class UserWriteModel {
  constructor(
    @Inject(USER_READER) private readonly reader: UserReader,
    @Inject(USER_WRITER) private readonly writer: UserWriter,
    private readonly cache: UsersReadModelCache,
  ) {}

  /** Reads the row this write is about, or answers 404. */
  require(id: string): Promise<User> {
    return requireUser(this.reader, id);
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
    const user = await this.require(id);
    requireConditional(expected);
    if (!isSatisfiedBy(expected, user.version)) {
      throw new PreconditionFailedException(describeMismatch(expected, user.version));
    }
    return user;
  }

  /** The write itself, once every precondition has been cleared. */
  async applyUpdate(
    id: string,
    data: UpdateUserData,
    expected: ExpectedVersion,
    tx?: TransactionContext,
  ): Promise<User> {
    const updated = await this.conditionally(() => this.writer.update(id, data, expected, tx));
    await this.cache.evictUser(id);
    return updated;
  }

  /**
   * Runs a conditional write, translating a storage-layer conflict into 412.
   *
   * The store raises `VersionConflictError`, which names no status because it
   * is not an HTTP concern where it is thrown. This is the boundary where it
   * becomes one, so the mapping lives here once rather than in each of the four
   * commands that can hit it.
   */
  async conditionally<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof VersionConflictError) {
        throw new PreconditionFailedException(error.message);
      }
      throw error;
    }
  }
}
