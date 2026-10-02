import { Injectable } from "@nestjs/common";
import { PrismaService, ExtendedPrismaClient } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { setTransactionTenant } from "@/tenancy/tenant-prisma";
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
  /**
   * The tenant-scoped client, and the only one this class reads or writes
   * through.
   *
   * Every statement below used to go to `this.prisma` directly. Under the
   * policies that would not be a subtle degradation: a `users` read on the pooled
   * client runs in its own implicit transaction, where the transaction-local
   * tenant setting from somebody else's transaction does not apply, so the
   * predicate sees NULL and the row count is zero. The scoped client is what puts
   * the setting and the query in one transaction — see `tenantScopeExtension`.
   *
   * Built once in the constructor and reused: the tenant is read per operation
   * from the `AsyncLocalStorage`, not captured here, so one long-lived client
   * serves every request.
   */
  private readonly scoped: ExtendedPrismaClient;

  constructor(private readonly prisma: PrismaService) {
    this.scoped = prisma.withExtensions();
  }

  // Every read below is `async` and awaits inside, rather than handing the caller
  // Prisma's promise to await later. The difference is where the statement runs: a
  // `PrismaPromise` is lazy, so an operation *returned* from here executes in
  // whatever async context eventually awaits it — and the tenant is read when it
  // executes. Awaiting here keeps the read inside the caller's tenant scope, where
  // it was asked for. A promise that escaped its scope would be refused rather than
  // mis-scoped (see `tenantScopeExtension`), so this is about working rather than
  // about safety.
  async findById(id: string): Promise<User | null> {
    return await this.scoped.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return await this.scoped.user.findUnique({ where: { email } });
  }

  async findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    return await this.scoped.user.findFirst({ where: { provider, providerAccountId } });
  }

  async findMany(query: UserListQuery): Promise<User[]> {
    return await this.scoped.user.findMany({
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
    return this.write(tx, (client) => client.user.create({ data }));
  }

  async update(
    id: string,
    data: UpdateUserData,
    expected: ExpectedVersion,
    tx?: TransactionContext,
  ): Promise<User> {
    try {
      return await this.write(tx, (client) =>
        client.user.update({
          where: { id, ...versionPredicate(expected) },
          data: { ...data, version: { increment: 1 } },
        }),
      );
    } catch (error) {
      throw await this.explainWriteFailure(id, expected, error);
    }
  }

  async delete(id: string, expected: ExpectedVersion, tx?: TransactionContext): Promise<User> {
    try {
      return await this.write(tx, (client) =>
        client.user.delete({ where: { id, ...versionPredicate(expected) } }),
      );
    } catch (error) {
      throw await this.explainWriteFailure(id, expected, error);
    }
  }

  /**
   * Runs a write in the caller's transaction, or in one opened for it.
   *
   * It used to pick a *client* rather than own the call, and the tenant setting is
   * what changed that: the setting is transaction-local, so a write on the pooled
   * client outside any transaction has no tenant — the `require_tenant_id()`
   * default refuses the insert and the policies match no row to update. A write
   * with no caller transaction therefore opens its own and sets the tenant in it,
   * which is precisely what `tenantScopeExtension` does for the reads above; it is
   * written out here instead because `Prisma.TransactionClient` and the extended
   * client are not the same type, and a helper returning either of them could only
   * do so through a cast.
   *
   * The read-back in `explainWriteFailure` deliberately stays outside this. It
   * runs *after* a failed write, when the caller's transaction is already doomed,
   * and issuing another statement on an aborted transaction fails with `25P02`
   * rather than answering the question.
   */
  private write<T>(
    tx: TransactionContext | undefined,
    work: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) return work(requirePrismaTransaction(tx, PrismaUsersRepository.name));

    return this.prisma.$transaction(async (client) => {
      await setTransactionTenant(client);
      return work(client);
    });
  }

  getPreferences(id: string): Promise<UserPreferences> {
    return this.scoped.user.getPreferences(id);
  }

  async setPreferences(
    id: string,
    patch: Partial<UserPreferences>,
    expected: ExpectedVersion,
  ): Promise<PreferencesWriteResult> {
    try {
      return await this.scoped.user.setPreferences(id, patch, versionPredicate(expected).version);
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
    const current = await this.scoped.user.findUnique({
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
