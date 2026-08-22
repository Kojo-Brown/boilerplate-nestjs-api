import { deepFreeze, isDeeplyFrozen } from "./deep-freeze";

describe("deepFreeze", () => {
  it("freezes nested plain data all the way down", () => {
    const value = deepFreeze({ a: { b: { c: [1, 2, 3] } } });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b.c)).toBe(true);
    expect(isDeeplyFrozen(value)).toBe(true);
  });

  it("returns the same object rather than a frozen copy", () => {
    const source = { a: 1 };
    expect(deepFreeze(source)).toBe(source);
  });

  it("throws on a write, because every compiled module is strict mode", () => {
    // `strict: true` implies `alwaysStrict`. Were that not so, each of these
    // writes would be silently discarded and the guard would report nothing —
    // so this is really a test of the tsconfig, from the one place that
    // depends on it.
    const value = deepFreeze({ nested: { count: 1 }, list: [1] });

    expect(() => {
      (value.nested as { count: number }).count = 2;
    }).toThrow(TypeError);
    expect(() => {
      (value as { added?: number }).added = 1;
    }).toThrow(TypeError);
    expect(() => (value.list as number[]).push(2)).toThrow(TypeError);
    expect(value.nested.count).toBe(1);
  });

  describe("values it must not attempt to freeze", () => {
    it("skips Buffers instead of throwing on them", () => {
      // `Object.freeze` on a non-empty array-buffer view throws
      // "Cannot freeze array buffer views with elements". A deep freeze that
      // did not special-case this would crash on the first payload carrying
      // binary data rather than protecting anything.
      const payload = { name: "avatar.png", bytes: Buffer.from("not-a-real-image") };

      expect(() => deepFreeze(payload)).not.toThrow();
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.isFrozen(payload.bytes)).toBe(false);
      // Still counted as fully frozen: `isDeeplyFrozen` mirrors the same skip
      // rules, so the two cannot disagree about a payload like this one.
      expect(isDeeplyFrozen(payload)).toBe(true);
    });

    it("skips typed arrays and array buffers the same way", () => {
      const payload = { view: new Uint16Array([1, 2]), raw: new ArrayBuffer(8) };
      expect(() => deepFreeze(payload)).not.toThrow();
    });

    it("leaves functions alone", () => {
      // Freezing a function breaks anything that hangs state off it, and buys
      // nothing: the body can still mutate whatever it closes over.
      const fn = () => 1;
      deepFreeze({ fn });
      expect(Object.isFrozen(fn)).toBe(false);
    });
  });

  it("terminates on a cyclic graph", () => {
    interface Node {
      name: string;
      self?: Node;
      peer?: Node;
    }
    const a: Node = { name: "a" };
    const b: Node = { name: "b", peer: a };
    a.self = a;
    a.peer = b;

    expect(() => deepFreeze(a)).not.toThrow();
    expect(Object.isFrozen(b)).toBe(true);
    expect(isDeeplyFrozen(a)).toBe(true);
  });

  it("never invokes an accessor while traversing", () => {
    const getter = jest.fn(() => ({ lazy: true }));
    const value = {};
    Object.defineProperty(value, "expensive", { get: getter, enumerable: true });

    deepFreeze(value);
    isDeeplyFrozen(value);

    // Walking `Object.values()` would call this — running whatever side effect
    // or throw a lazy getter carries, during a traversal that is meant to be
    // inert.
    expect(getter).not.toHaveBeenCalled();
  });

  it("freezes non-enumerable and symbol-keyed properties too", () => {
    const tag = Symbol("tag");
    const value: Record<string | symbol, unknown> = { [tag]: { deep: 1 } };
    Object.defineProperty(value, "hidden", {
      value: { deep: 1 },
      enumerable: false,
      writable: true,
      configurable: true,
    });

    deepFreeze(value);

    expect(Object.isFrozen(value[tag])).toBe(true);
    expect(Object.isFrozen(value["hidden"])).toBe(true);
  });

  it("freezes the entries of Maps and Sets", () => {
    const entry = { deep: 1 };
    const map = new Map([["key", entry]]);
    const set = new Set([entry]);

    deepFreeze({ map, set });

    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("does not stop Map, Set or Date mutation — only the type layer does", () => {
    // Documented rather than papered over. These mutate internal slots, not
    // properties, so no amount of freezing reaches them; `DeepReadonly` maps
    // them to `ReadonlyMap`/`ReadonlySet` so the compiler refuses instead.
    const map = new Map<string, number>();
    const set = new Set<number>();
    const date = new Date(0);
    deepFreeze({ map, set, date });

    expect(() => map.set("a", 1)).not.toThrow();
    expect(() => set.add(1)).not.toThrow();
    expect(() => date.setUTCFullYear(2000)).not.toThrow();
    expect(map.size).toBe(1);
    expect(date.getUTCFullYear()).toBe(2000);

    // What it *does* stop on a Date: bolting a property onto a shared one.
    expect(() => {
      (date as unknown as Record<string, unknown>)["scratch"] = 1;
    }).toThrow(TypeError);
  });

  it("freezes class instances, which is what a validated DTO is", () => {
    class UpdateDto {
      name = "jane";
      nested = { theme: "dark" };
    }
    const dto = deepFreeze(new UpdateDto());

    expect(() => {
      (dto as unknown as UpdateDto).name = "changed";
    }).toThrow(TypeError);
    expect(Object.isFrozen(dto.nested)).toBe(true);
  });

  it("passes primitives and null through untouched", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze(7)).toBe(7);
    expect(isDeeplyFrozen(null)).toBe(true);
    expect(isDeeplyFrozen("x")).toBe(true);
  });
});

describe("isDeeplyFrozen", () => {
  it("reports a shallow freeze as incomplete", () => {
    const value = Object.freeze({ nested: { count: 1 } });

    expect(Object.isFrozen(value)).toBe(true);
    expect(isDeeplyFrozen(value)).toBe(false);
  });

  it("finds an unfrozen value inside a Map or a Set", () => {
    const map = new Map([["k", { deep: 1 }]]);
    Object.freeze(map);
    expect(isDeeplyFrozen(map)).toBe(false);

    const set = new Set([{ deep: 1 }]);
    Object.freeze(set);
    expect(isDeeplyFrozen(set)).toBe(false);
  });

  it("terminates on a cycle it is asked about", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(isDeeplyFrozen(a)).toBe(false);

    deepFreeze(a);
    expect(isDeeplyFrozen(a)).toBe(true);
  });
});
