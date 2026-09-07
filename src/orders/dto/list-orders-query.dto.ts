import { CursorPaginationDto } from "@/common/pagination";

/**
 * Orders are listed by cursor and nothing else.
 *
 * No search, no status filter, no date range — deliberately, and not as an
 * omission to fill in later. Each of those is an index on a table that is
 * append-only and read almost exclusively by its owner, and a filter added
 * before anybody has asked for it is a query plan nobody has measured. It
 * extends the shared DTO so that `cursor` and `limit` mean and validate exactly
 * what they do on `/v1/users`.
 */
export class ListOrdersQueryDto extends CursorPaginationDto {}
