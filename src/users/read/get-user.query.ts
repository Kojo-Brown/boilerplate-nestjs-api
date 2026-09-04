import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import type { User } from "@prisma/client";
import { USER_READER, type UserReader } from "../ports";
import { requireUser } from "../require-user";

/**
 * One user by id, or 404.
 *
 * `Query<User>` rather than a bare class: the generic parameter is what makes
 * `queryBus.execute(new GetUserQuery(id))` resolve to `Promise<User>` instead
 * of `Promise<any>`, which is the difference between a bus that keeps its types
 * and one that quietly erases them at every call site.
 */
export class GetUserQuery extends Query<User> {
  constructor(readonly id: string) {
    super();
  }
}

@QueryHandler(GetUserQuery)
export class GetUserHandler implements IQueryHandler<GetUserQuery> {
  constructor(@Inject(USER_READER) private readonly reader: UserReader) {}

  execute({ id }: GetUserQuery): Promise<User> {
    return requireUser(this.reader, id);
  }
}
