import type { CursorPage } from "./cursor-page";

/** Encodes a raw ID string into a URL-safe base64 cursor token. */
export function encodeCursor(id: string): string {
  return Buffer.from(id).toString("base64url");
}

/** Decodes a base64url cursor token back to the raw ID string. */
export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

/**
 * Builds a CursorPage<T> from rows fetched with limit + 1.
 *
 * The caller must query `limit + 1` rows from the database. Pass all of them
 * here along with the actual page `limit`. The last visible item's ID becomes
 * the next cursor.
 *
 * @param rows   Results from DB — fetch limit + 1 to detect next page
 * @param limit  Page size the client requested
 * @param getId  Extracts the ID field used for cursor encoding (defaults to item.id)
 */
export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  getId: (item: T) => string = (item) => (item as unknown as { id: string }).id,
): CursorPage<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasNextPage && lastItem !== undefined ? encodeCursor(getId(lastItem)) : null;
  return { items, nextCursor, hasNextPage };
}

/**
 * Converts an optional cursor query param into a Prisma `cursor` argument.
 * Returns `undefined` on the first page (no cursor provided).
 *
 * Usage with Prisma:
 *   const rows = await prisma.user.findMany({
 *     take: query.limit + 1,
 *     cursor: parseCursorArg(query.cursor),
 *     skip: query.cursor ? 1 : 0,
 *     orderBy: { createdAt: 'asc' },
 *   });
 */
export function parseCursorArg(cursor: string | undefined): { id: string } | undefined {
  if (!cursor) return undefined;
  return { id: decodeCursor(cursor) };
}
