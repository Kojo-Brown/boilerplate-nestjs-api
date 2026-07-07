import { buildCursorPage, decodeCursor, encodeCursor, parseCursorArg } from "./build-cursor-page";

interface Item {
  id: string;
  name: string;
}

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `id-${i + 1}`, name: `Item ${i + 1}` }));
}

describe("encodeCursor / decodeCursor", () => {
  it("round-trips an ID through base64url encoding", () => {
    const id = "clx1abc123def";
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it("produces URL-safe characters (no +, /, or =)", () => {
    const cursor = encodeCursor("some-arbitrary-id-value");
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("handles IDs with special characters", () => {
    const id = "user+123/test=value";
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });
});

describe("buildCursorPage", () => {
  it("returns all items and null cursor when rows < limit", () => {
    const rows = makeItems(5);
    const page = buildCursorPage(rows, 20);
    expect(page.items).toHaveLength(5);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("returns exactly limit items and a cursor when rows.length === limit + 1", () => {
    const rows = makeItems(21);
    const page = buildCursorPage(rows, 20);
    expect(page.items).toHaveLength(20);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("cursor encodes the ID of the last returned item", () => {
    const rows = makeItems(6);
    const page = buildCursorPage(rows, 5);
    expect(page.nextCursor).toBe(encodeCursor("id-5"));
  });

  it("uses a custom getId function when provided", () => {
    const rows = [
      { uuid: "abc", label: "A" },
      { uuid: "def", label: "B" },
      { uuid: "ghi", label: "C" },
    ];
    const page = buildCursorPage(rows, 2, (item) => item.uuid);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(encodeCursor("def"));
  });

  it("handles an empty result set", () => {
    const page = buildCursorPage([], 20);
    expect(page.items).toHaveLength(0);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("returns no cursor when rows equal exactly limit (no next page)", () => {
    const rows = makeItems(20);
    const page = buildCursorPage(rows, 20);
    expect(page.items).toHaveLength(20);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("correctly slices when many extra rows are present", () => {
    const rows = makeItems(50);
    const page = buildCursorPage(rows, 10);
    expect(page.items).toHaveLength(10);
    expect(page.items[0]!.id).toBe("id-1");
    expect(page.items[9]!.id).toBe("id-10");
    expect(page.nextCursor).toBe(encodeCursor("id-10"));
  });
});

describe("parseCursorArg", () => {
  it("returns undefined for undefined (first page)", () => {
    expect(parseCursorArg(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseCursorArg("")).toBeUndefined();
  });

  it("decodes a valid cursor into a Prisma cursor arg", () => {
    const cursor = encodeCursor("cuid_abc123");
    expect(parseCursorArg(cursor)).toEqual({ id: "cuid_abc123" });
  });

  it("round-trips through encode → parseCursorArg", () => {
    const originalId = "clxabc123";
    const cursorArg = parseCursorArg(encodeCursor(originalId));
    expect(cursorArg).toEqual({ id: originalId });
  });
});
