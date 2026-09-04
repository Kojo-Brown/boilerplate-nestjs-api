import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import type { User } from "@prisma/client";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import { USER_READER, type UserReader } from "../ports";
import type { ListUsersQueryDto } from "../dto/list-users-query.dto";

/** A page of users, admin-only at the HTTP edge. */
export class ListUsersQuery extends Query<CursorPage<User>> {
  constructor(readonly criteria: ListUsersQueryDto) {
    super();
  }
}

@QueryHandler(ListUsersQuery)
export class ListUsersHandler implements IQueryHandler<ListUsersQuery> {
  constructor(@Inject(USER_READER) private readonly reader: UserReader) {}

  /**
   * The cursor is opaque to the client and decoded here rather than in the DTO,
   * so a malformed one is this handler's problem and not the validation
   * pipeline's — `decodeCursor` answers 400 with a message about the cursor
   * instead of a class-validator report about a string that failed no rule.
   */
  async execute({ criteria }: ListUsersQuery): Promise<CursorPage<User>> {
    const cursor = criteria.cursor ? decodeCursor(criteria.cursor) : undefined;
    const rows = await this.reader.findMany({
      cursor,
      limit: criteria.limit,
      search: criteria.search,
    });
    return buildCursorPage(rows, criteria.limit);
  }
}
