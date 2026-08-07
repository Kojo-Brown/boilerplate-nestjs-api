import { UnserializableArgumentError, buildDefaultCacheKey, stableStringify } from "./cache-key";

describe("stableStringify", () => {
  it("is insensitive to object key order", () => {
    expect(stableStringify({ role: "ADMIN", limit: 10 })).toBe(
      stableStringify({ limit: 10, role: "ADMIN" }),
    );
  });

  it("sorts keys at every level, not just the top", () => {
    expect(stableStringify({ a: { z: 1, y: 2 } })).toBe(stableStringify({ a: { y: 2, z: 1 } }));
  });

  it("keeps array order, which is meaningful", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("distinguishes a missing property from an explicit undefined", () => {
    // JSON.stringify drops `undefined` values, which would collide these two.
    expect(stableStringify({ a: 1, b: undefined })).not.toBe(stableStringify({ a: 1 }));
  });

  it("distinguishes a Date from its own ISO string", () => {
    const date = new Date("2024-03-01T10:00:00.000Z");
    expect(stableStringify(date)).not.toBe(stableStringify(date.toISOString()));
  });

  it("distinguishes a bigint from the equivalent number", () => {
    expect(stableStringify(1n)).not.toBe(stableStringify(1));
  });

  it("serialises the primitives it accepts", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("undefined");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(1.5)).toBe("1.5");
    expect(stableStringify("a")).toBe('"a"');
    expect(stableStringify(/ab+/gi)).toBe("RegExp(ab+/gi)");
    expect(stableStringify([])).toBe("[]");
    expect(stableStringify({})).toBe("{}");
  });

  it.each([
    ["a function", () => undefined],
    ["a symbol", Symbol("s")],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a Buffer", Buffer.from("x")],
    ["an ArrayBuffer", new ArrayBuffer(2)],
    ["an invalid Date", new Date("nonsense")],
  ])("refuses to key on %s", (_label, value) => {
    expect(() => stableStringify(value)).toThrow(UnserializableArgumentError);
  });

  it("refuses a circular reference rather than recursing forever", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(() => stableStringify(node)).toThrow(UnserializableArgumentError);
  });

  it("allows the same object to appear twice in one argument list", () => {
    // Repetition is not a cycle: only an object containing itself is.
    const shared = { id: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"id":1},{"id":1}]');
  });
});

describe("buildDefaultCacheKey", () => {
  const context = { target: "UsersService", method: "findById" };

  it("namespaces by class and method", () => {
    expect(buildDefaultCacheKey(context, ["abc"])).toBe('UsersService.findById:["abc"]');
  });

  it("prepends the configured prefix", () => {
    expect(buildDefaultCacheKey(context, ["abc"], "users")).toBe(
      'users:UsersService.findById:["abc"]',
    );
  });

  it("gives two methods that share an argument different keys", () => {
    expect(buildDefaultCacheKey(context, ["abc"])).not.toBe(
      buildDefaultCacheKey({ target: "PostsService", method: "findById" }, ["abc"]),
    );
  });

  it("separates arity: one undefined argument is not no arguments", () => {
    expect(buildDefaultCacheKey(context, [undefined])).not.toBe(buildDefaultCacheKey(context, []));
  });
});
