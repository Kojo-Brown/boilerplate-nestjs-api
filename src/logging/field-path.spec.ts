import {
  ARRAY_SEGMENT,
  childPath,
  elementPath,
  formatPath,
  matchesPattern,
  parsePattern,
} from "./field-path";

describe("field paths", () => {
  describe("formatPath", () => {
    it("joins segments with dots", () => {
      expect(formatPath(["query", "page"])).toBe("query.page");
    });

    it("attaches an array segment without a dot", () => {
      expect(formatPath(["items", ARRAY_SEGMENT, "sku"])).toBe("items[].sku");
    });

    it("renders a list of lists", () => {
      expect(formatPath(["grid", ARRAY_SEGMENT, ARRAY_SEGMENT])).toBe("grid[][]");
    });
  });

  describe("parsePattern", () => {
    it.each([
      ["userId", ["userId"]],
      ["query.page", ["query", "page"]],
      ["items[].sku", ["items", ARRAY_SEGMENT, "sku"]],
      ["grid[][]", ["grid", ARRAY_SEGMENT, ARRAY_SEGMENT]],
      ["counts.*", ["counts", "*"]],
    ])("parses %s", (pattern, expected) => {
      expect(parsePattern(pattern)).toEqual(expected);
    });

    it.each([
      ["", "empty"],
      [" userId", "leading space"],
      ["userId ", "trailing space"],
      [".userId", "leading dot"],
      ["userId.", "trailing dot"],
      ["a..b", "empty segment"],
      ["[]", "array with no field in front of it"],
      ["it[]ems", "brackets in the middle"],
      ["items[]x", "text after the brackets"],
      ["items]", "unbalanced bracket"],
    ])("refuses %s (%s)", (pattern) => {
      expect(parsePattern(pattern)).toBeUndefined();
    });
  });

  describe("matchesPattern", () => {
    it("matches an exact path", () => {
      expect(matchesPattern(["query", "page"], ["query", "page"])).toBe(true);
    });

    /**
     * The property an allowlist stands or falls on. Prefix matching would turn
     * "log the order" into "log everything anybody ever nests under the order",
     * silently, on a future commit that adds a field.
     */
    it("does not admit a child of an allowed path", () => {
      expect(matchesPattern(["user", "email"], ["user"])).toBe(false);
    });

    it("does not admit a parent of an allowed path", () => {
      expect(matchesPattern(["user"], ["user", "id"])).toBe(false);
    });

    it("admits any key under a wildcard segment", () => {
      expect(matchesPattern(["counts", "order.placed"], ["counts", "*"])).toBe(true);
      expect(matchesPattern(["counts", "user.registered"], ["counts", "*"])).toBe(true);
    });

    /**
     * A wildcard stands in for a key, not for an array element. A map of
     * dynamic keys and a list are different shapes, and admitting one because
     * the other was allowed means admitting a shape nobody looked at.
     */
    it("does not admit an array element under a wildcard", () => {
      expect(matchesPattern(["counts", ARRAY_SEGMENT], ["counts", "*"])).toBe(false);
    });

    /**
     * The reason matching works on segment arrays rather than on the rendered
     * string. A caller who controls a key controls the rendered path, so
     * `{"a.b": secret}` renders as `a.b` — and a matcher that split the path
     * back apart on `.` would hand that key the allowlist entry belonging to a
     * nested `{a: {b: …}}`.
     */
    it("does not let a key containing a dot impersonate a nested path", () => {
      expect(matchesPattern(["a.b"], ["a", "b"])).toBe(false);
    });
  });

  describe("path building", () => {
    it("does not mutate the parent", () => {
      const parent = ["user"];
      childPath(parent, "id");
      elementPath(parent);
      expect(parent).toEqual(["user"]);
    });
  });
});
