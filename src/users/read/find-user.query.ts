import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import type { User } from "@prisma/client";
import { USER_READER, type UserReader } from "../ports";

/**
 * Looks a user up by address, resolving with `null` when there is none.
 *
 * Deliberately not `GetUserQuery`'s 404: every caller is a sign-in path
 * deciding between "log this account in" and "create one", and an exception
 * would make the ordinary case — a first-time visitor — an error to catch.
 */
export class FindUserByEmailQuery extends Query<User | null> {
  constructor(readonly email: string) {
    super();
  }
}

@QueryHandler(FindUserByEmailQuery)
export class FindUserByEmailHandler implements IQueryHandler<FindUserByEmailQuery> {
  constructor(@Inject(USER_READER) private readonly reader: UserReader) {}

  execute({ email }: FindUserByEmailQuery): Promise<User | null> {
    return this.reader.findByEmail(email);
  }
}

/** The account linked to an OAuth identity, or `null` if it is not linked yet. */
export class FindUserByProviderAccountQuery extends Query<User | null> {
  constructor(
    readonly provider: string,
    readonly providerAccountId: string,
  ) {
    super();
  }
}

@QueryHandler(FindUserByProviderAccountQuery)
export class FindUserByProviderAccountHandler implements IQueryHandler<FindUserByProviderAccountQuery> {
  constructor(@Inject(USER_READER) private readonly reader: UserReader) {}

  execute({ provider, providerAccountId }: FindUserByProviderAccountQuery): Promise<User | null> {
    return this.reader.findByProviderAccount(provider, providerAccountId);
  }
}
