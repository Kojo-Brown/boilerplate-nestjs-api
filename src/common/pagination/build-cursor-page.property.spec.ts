import fc from "fast-check";
import { configureFastCheck } from "@/test-utils/fast-check";
import { buildCursorPage, decodeCursor, encodeCursor, parseCursorArg } from "./build-cursor-page";

/**
 * Property-based tests for cursor pagination.
 *
 * `cursor-pagination.spec.ts` checks one page at a time against hand-written
 * rows. The failure mode that actually bites a keyset paginator is not one
 * page being wrong, though — it is a *traversal* losing or repeating a row at
 * a boundary, which only appears when the pages are walked end to end at a
 * page size nobody tried. So the central property here is the whole walk:
 * fetch `limit + 1`, hand the rows to `buildCursorPage`, follow `nextCursor`,
 * repeat, and compare the concatenation against the list that was there.
 *
 * The query the walk simulates is the one documented on `parseCursorArg` —
 * Prisma's `cursor` plus `skip: 1` plus `take: limit + 1` — so a change to
 * either side of that contract shows up here rather than in production.
 *
 * Fixed seed; see `src/test-utils/fast-check.ts`.
 */
configureFastCheck();

interface Row {
  id: string;
  name: string;
}

/**
 * Rows with distinct ids, as a keyset cursor requires: the whole scheme rests
 * on the ordering column being unique, and a duplicate id would make the walk
 * ambiguous in the database long before it reached this code.
 */
const rows: fc.Arbitrary<Row[]> = fc
  .uniqueArray(fc.string({ minLength: 1, unit: "grapheme" }), { maxLength: 40 })
  .map((ids) => ids.map((id, index) => ({ id, name: `Item ${index}` })));

/** The page sizes the DTO admits (`@Min(1) @Max(100)`). */
const limit: fc.Arbitrary<number> = fc.integer({ min: 1, max: 100 });

/**
 * One page of the query `parseCursorArg` documents:
 * `take: limit + 1, cursor, skip: cursor ? 1 : 0`.
 */
function fetchPage(all: Row[], cursor: string | undefined, pageSize: number): Row[] {
  const cursorArg = parseCursorArg(cursor);
  const start = cursorArg === undefined ? 0 : all.findIndex((row) => row.id === cursorArg.id) + 1;
  return all.slice(start, start + pageSize + 1);
}

describe("cursor pagination (properties)", () => {
  it("walks every row exactly once, in order, whatever the page size", () => {
    fc.assert(
      fc.property(rows, limit, (all, pageSize) => {
        const visited: Row[] = [];
        let cursor: string | undefined;
        let pages = 0;

        for (;;) {
          const page = buildCursorPage(fetchPage(all, cursor, pageSize), pageSize);
          pages += 1;
          visited.push(...page.items);

          if (!page.hasNextPage) break;
          // A page that says there is more and offers nothing to continue from
          // is the one way this loop could spin forever; asserted rather than
          // guarded, so it fails as itself instead of as a timeout.
          expect(page.nextCursor).not.toBeNull();
          cursor = page.nextCursor ?? undefined;
          expect(pages).toBeLessThanOrEqual(all.length + 1);
        }

        // No row lost, none repeated, none reordered — the three things a
        // keyset boundary gets wrong.
        expect(visited).toEqual(all);
        expect(pages).toBe(Math.max(1, Math.ceil(all.length / pageSize)));
      }),
    );
  });

  it("returns a prefix of its rows, and a cursor exactly when there is a next page", () => {
    // `limit` here is a `nat`, not the DTO's 1–100: `buildCursorPage` is also
    // called with 0 by a caller that asked for nothing, and `0` is the single
    // input where there is a next page and no last item to encode. Negative
    // page sizes are left out — `slice(0, -1)` would drop a row, and the DTO's
    // `@Min(1)` is what stops one reaching here.
    fc.assert(
      fc.property(rows, fc.nat({ max: 60 }), (all, pageSize) => {
        const page = buildCursorPage(all, pageSize);

        expect(page.items).toEqual(all.slice(0, pageSize));
        expect(page.hasNextPage).toBe(all.length > pageSize);
        expect(page.nextCursor === null).toBe(!page.hasNextPage || page.items.length === 0);
        if (page.nextCursor !== null) {
          expect(decodeCursor(page.nextCursor)).toBe(page.items[page.items.length - 1]?.id);
        }
      }),
    );
  });

  it("encodes the caller's own id function rather than assuming `.id`", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 20 }),
        (uuids, pageSize) => {
          const custom = uuids.map((uuid) => ({ uuid }));

          const page = buildCursorPage(custom, pageSize, (item) => item.uuid);

          expect(page.items).toEqual(custom.slice(0, pageSize));
          if (page.nextCursor !== null) {
            expect(decodeCursor(page.nextCursor)).toBe(custom[pageSize - 1]?.uuid);
          }
        },
      ),
    );
  });

  it("round-trips any id a database could hold, through URL-safe characters", () => {
    // `unit: "grapheme"` rather than any sequence of UTF-16 units: a lone
    // surrogate has no UTF-8 encoding at all, so `Buffer` replaces it with
    // U+FFFD and no round-trip is possible — a property of the encoding, not
    // of this code, and not something a primary key can contain.
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (id) => {
        const cursor = encodeCursor(id);

        expect(cursor).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(decodeCursor(cursor)).toBe(id);
      }),
    );
  });

  it("turns any cursor a client sends into a Prisma argument without throwing", () => {
    // The cursor is a query parameter, so every string is reachable, and
    // `parseCursorArg` runs before any validation of what it decodes to. A
    // throw here would be a 500 on a request that deserves an empty page.
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        const parsed = parseCursorArg(candidate);

        expect(parsed === undefined).toBe(candidate === "");
        if (parsed !== undefined) expect(typeof parsed.id).toBe("string");
      }),
    );
  });

  it("parses back the cursor it encoded", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, unit: "grapheme" }), (id) => {
        expect(parseCursorArg(encodeCursor(id))).toEqual({ id });
      }),
    );
  });
});
