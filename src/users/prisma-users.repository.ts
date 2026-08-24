import { Injectable } from "@nestjs/common";
import { PrismaService, ExtendedPrismaClient } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { VersionConflictError, isSatisfiedBy } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import type { UserPreferences } from "@/users/types/user-preferences";
import type {
  CreateUserData,
  PreferencesWriteResult,
  UpdateUserData,
  UserListQuery,
  UserPreferencesStore,
  UserReader,
  UserWriter,
} from "./ports";

/**
 * The Prisma-backed adapter for the three user ports.
 *
 * One class implements all three: they are split for the *consumers*' benefit,
 * not to force three adapters on anyone who only has one database. The module
 * binds each token to this class with `useExisting`, so all three tokens
 * resolve to a single instance.
 */
@Injectable()
export class PrismaUsersRepository implements UserReader, UserWriter, UserPreferencesStore {
  private readonly extended: ExtendedPrismaClient;

  constructor(private readonly prisma: PrismaService) {
    this.extended = prisma.withExtensions();
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { provider, providerAccountId } });
  }

  findMany(query: UserListQuery): Promise<User[]> {
    return this.prisma.user.findMany({
      take: query.limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      orderBy: { createdAt: "asc" },
      where: query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : undefined,
    });
  }

  create(data: CreateUserData, tx?: TransactionContext): Promise<User> {
    return this.writer(tx).user.create({ data });
  }

  async update(
    id: string,
    data: UpdateUserData,
    expected: ExpectedVersion,
    tx?: TransactionContext,
  ): Promise<User> {
    try {
      return await this.writer(tx).user.update({
        where: { id, ...versionPredicate(expected) },
        data: { ...data, version: { increment: 1 } },
      });
    } catch (error) {
      throw await this.explainWriteFailure(id, expected, error);
    }
  }

  async delete(id: string, expected: ExpectedVersion, tx?: TransactionContext): Promise<User> {
    try {
      return await this.writer(tx).user.delete({ where: { id, ...versionPredicate(expected) } });
    } catch (error) {
      throw await this.explainWriteFailure(id, expected, error);
    }
  }

  /**
   * The client a write should run on: the caller's transaction if there is one,
   * the pooled client otherwise.
   *
   * `Prisma.TransactionClient` is `PrismaClient` minus `$transaction` and the
   * other connection-level methods, and the model delegates this class uses are
   * identical on both — so one helper covers every write without either branch
   * duplicating the query.
   *
   * The read-back in `explainWriteFailure` deliberately stays on the pooled
   * client. It runs *after* a failed write, when the caller's transaction is
   * already doomed, and issuing another statement on an aborted transaction
   * fails with `25P02` rather than answering the question.
   */
  private writer(tx?: TransactionContext): Pick<PrismaService, "user"> {
    return tx ? requirePrismaTransaction(tx, PrismaUsersRepository.name) : this.prisma;
  }

  getPreferences(id: string): Promise<UserPreferences> {
    return this.extended.user.getPreferences(id);
  }

  async setPreferences(
    id: string,
    patch: Partial<UserPreferences>,
    expected: ExpectedVersion,
  ): Promise<PreferencesWriteResult> {
    try {
      return await this.extended.user.setPreferences(id, patch, versionPredicate(expected).version);
    } catch (error) {
      throw await this.explainWriteFailure(id, expected, error);
    }
  }

  /**
   * Decides whether a failed conditional write was a conflict or something else.
   *
   * Prisma reports "no row matched the `where`" as P2025 whether the row is
   * absent or merely at another version, and the two are a 404 and a 412. So
   * rather than reading the error, this reads the row back: a row that exists
   * and does not satisfy `expected` is a conflict, and anything else is the
   * original failure, rethrown untouched.
   *
   * Going through the state rather than the error code is also what keeps this
   * honest against a store that is not really Prisma — the e2e suite runs the
   * whole application against an in-memory fake whose errors carry no codes at
   * all, and a `P2025` check would have quietly classified every one of its
   * conflicts as a 500.
   *
   * The read-back is not atomic with the write, so the version it reports may
   * already be stale. That is acceptable for a diagnostic: the client's next
   * move is to re-read anyway, and a version that moved again only means it
   * lost to someone newer.
   */
  private async explainWriteFailure(
    id: string,
    expected: ExpectedVersion,
    error: unknown,
  ): Promise<unknown> {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { version: true },
    });
    if (current && !isSatisfiedBy(expected, current.version)) {
      return new VersionConflictError(current.version);
    }
    return error;
  }
}

/**
 * The `expected` version as a Prisma filter, to be spread into a `where`.
 *
 * `unconditional` and `*` add nothing: the first checks no version, and the
 * second asserts only that the row exists, which `where: { id }` already does.
 * A list becomes `version IN (…)`, and a list that named no version this server
 * could have issued becomes `IN ()` — matching nothing, which is exactly right:
 * a validator we never minted cannot be the one the client is holding.
 */
function versionPredicate(expected: ExpectedVersion): { version?: Prisma.IntFilter } {
  if (expected.mode !== "list") return {};

  const versions = expected.tags
    .filter((tag) => !tag.weak && tag.version !== null)
    .map((tag) => tag.version as number);

  return { version: { in: versions } };
}
