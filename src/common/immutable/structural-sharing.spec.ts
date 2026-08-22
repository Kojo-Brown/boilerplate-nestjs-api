import { deepFreeze, isDeeplyFrozen } from "./deep-freeze";
import { mapArray, patch, removeKey, setKey, updateKey } from "./structural-sharing";

interface Preferences {
  theme: "light" | "dark";
  language: string;
  emailNotifications: boolean;
}

interface Profile {
  name: string;
  preferences: Preferences;
  tags: readonly string[];
}

const profile = (): Profile => ({
  name: "Jane",
  preferences: { theme: "light", language: "en", emailNotifications: true },
  tags: ["a", "b"],
});

describe("setKey", () => {
  it("returns the input itself when the value is already there", () => {
    const source = profile();
    expect(setKey(source, "name", "Jane")).toBe(source);
  });

  it("shares every untouched subtree with the input", () => {
    const source = profile();
    const next = setKey(source, "name", "Joan");

    expect(next).not.toBe(source);
    expect(next.name).toBe("Joan");
    // Reference identity, not equality: this is what makes "did preferences
    // change?" a pointer comparison for everyone holding the old value.
    expect(next.preferences).toBe(source.preferences);
    expect(next.tags).toBe(source.tags);
    expect(source.name).toBe("Jane");
  });

  it("treats NaN as unchanged and -0 as a change", () => {
    // `Object.is`, not `===`. `NaN === NaN` is false, so `===` would report a
    // spurious change on every no-op write of a NaN; `-0 === +0` is true, so it
    // would miss a real one.
    const source = { value: Number.NaN };
    expect(setKey(source, "value", Number.NaN)).toBe(source);

    const zero = { value: 0 };
    expect(setKey(zero, "value", -0)).not.toBe(zero);
  });

  it("adds a key that is absent even when the new value is undefined", () => {
    // `Object.is(undefined, undefined)` cannot tell "already undefined" from
    // "absent", and the two differ to `Object.keys`, `JSON.stringify` and
    // Prisma alike.
    const source: { maybe?: string } = {};
    const next = setKey(source, "maybe", undefined);

    expect(next).not.toBe(source);
    expect("maybe" in next).toBe(true);
  });
});

describe("updateKey", () => {
  it("returns the input itself when the updater returns what it was given", () => {
    const source = profile();
    expect(updateKey(source, "preferences", (current) => current)).toBe(source);
  });

  it("composes so a no-op deep inside propagates all the way out", () => {
    const source = profile();
    const next = updateKey(source, "preferences", (current) => patch(current, { theme: "light" }));

    // The inner `patch` found nothing to change, so it returned its input,
    // so `updateKey` had nothing to set, so the whole update is the original.
    expect(next).toBe(source);
  });

  it("rebuilds only the spine down to a real change", () => {
    const source = profile();
    const next = updateKey(source, "preferences", (current) => patch(current, { theme: "dark" }));

    expect(next).not.toBe(source);
    expect(next.preferences).not.toBe(source.preferences);
    expect(next.preferences.theme).toBe("dark");
    expect(next.preferences.language).toBe("en");
    expect(next.tags).toBe(source.tags);
    expect(source.preferences.theme).toBe("light");
  });
});

describe("patch", () => {
  it("ignores keys whose value is undefined", () => {
    // The case this exists for: a validated DTO instance has every optional
    // key *present* and all but the supplied ones `undefined`, so a plain
    // spread would blank out five settings to change one.
    const source = profile().preferences;
    const dto: Partial<Preferences> = {
      theme: undefined,
      language: undefined,
      emailNotifications: false,
    };

    const next = patch(source, dto);

    expect(next.emailNotifications).toBe(false);
    expect(next.theme).toBe("light");
    expect(next.language).toBe("en");
  });

  it("returns the input itself when every defined key already matches", () => {
    const source = profile().preferences;
    expect(patch(source, { theme: "light", language: "en" })).toBe(source);
    expect(patch(source, {})).toBe(source);
    expect(patch(source, { theme: undefined })).toBe(source);
  });

  it("applies several keys in one copy", () => {
    const source = profile().preferences;
    const next = patch(source, { theme: "dark", language: "fr" });

    expect(next).toEqual({ theme: "dark", language: "fr", emailNotifications: true });
    expect(source.theme).toBe("light");
  });
});

describe("removeKey", () => {
  it("returns the input itself when the key is not there", () => {
    const source: { a: number; b?: number } = { a: 1 };
    expect(removeKey(source, "b")).toBe(source);
  });

  it("drops the key without touching the rest", () => {
    const source = profile();
    const next = removeKey(source, "name");

    expect("name" in next).toBe(false);
    expect(next.preferences).toBe(source.preferences);
  });
});

describe("mapArray", () => {
  it("returns the input itself when every element maps to itself", () => {
    const source = [{ id: 1 }, { id: 2 }];
    expect(mapArray(source, (item) => item)).toBe(source);
  });

  it("keeps the identity of the elements it did not change", () => {
    const first = { id: 1, done: false };
    const second = { id: 2, done: false };
    const source = [first, second];

    const next = mapArray(source, (item) => (item.id === 2 ? { ...item, done: true } : item));

    expect(next).not.toBe(source);
    expect(next[0]).toBe(first);
    expect(next[1]).not.toBe(second);
    expect(second.done).toBe(false);
  });
});

describe("frozen-ness is preserved rather than data-dependent", () => {
  // The failure this rules out: an update that happens to change nothing
  // returns the frozen input and throws on a later write, while the same call
  // with different data returns a thawed copy and accepts one. A guard that
  // fires for only some inputs is worse than no guard.
  it("returns a frozen value from a frozen input, whether or not anything changed", () => {
    const source = deepFreeze(profile());

    const changed = setKey(source, "name", "Joan");
    const unchanged = setKey(source, "name", "Jane");

    expect(isDeeplyFrozen(changed)).toBe(true);
    expect(unchanged).toBe(source);
    expect(() => {
      (changed as { name: string }).name = "x";
    }).toThrow(TypeError);
  });

  it("freezes values the caller newly supplied, not just the reused spine", () => {
    const source = deepFreeze(profile());
    const next = setKey(source, "preferences", {
      theme: "dark",
      language: "de",
      emailNotifications: false,
    });

    expect(isDeeplyFrozen(next)).toBe(true);
    expect(() => {
      (next.preferences as { theme: string }).theme = "light";
    }).toThrow(TypeError);
  });

  it("leaves an unfrozen input unfrozen", () => {
    const next = patch(profile().preferences, { theme: "dark" });
    expect(Object.isFrozen(next)).toBe(false);
  });

  it("applies to every helper", () => {
    const source = deepFreeze(profile());

    expect(isDeeplyFrozen(removeKey(source, "name"))).toBe(true);
    expect(isDeeplyFrozen(updateKey(source, "name", () => "Joan"))).toBe(true);
    expect(isDeeplyFrozen(patch(source, { name: "Joan" }))).toBe(true);
    expect(isDeeplyFrozen(mapArray(deepFreeze([{ id: 1 }]), () => ({ id: 2 })))).toBe(true);
  });
});
