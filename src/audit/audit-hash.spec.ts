import { createHash } from "crypto";
import type { NewAuditEntry } from "./audit-entry";
import {
  auditEntryHash,
  auditEntryPreimage,
  AuditEncodingError,
  canonicalJson,
  FIRST_SEQ,
  GENESIS_HASH,
  isChainHash,
  sealAuditEntry,
} from "./audit-hash";

function draft(overrides: Partial<NewAuditEntry<"user.deleted">> = {}) {
  return {
    action: "user.deleted",
    resourceId: "usr-1",
    details: { email: "gone@example.test" },
    actor: { id: "adm-1", role: "ADMIN" },
    correlationId: "corr-1",
    occurredAt: new Date("2026-09-16T12:00:00.000Z"),
    ...overrides,
  } satisfies NewAuditEntry<"user.deleted">;
}

describe("canonicalJson", () => {
  it("is independent of the order keys were inserted in", () => {
    // The property the whole chain rests on. `JSON.stringify` follows insertion
    // order, so without this an entry built one way and verified another would
    // be reported as tampered with.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it("keeps array order, which is part of the value", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("escapes strings the way JSON does, so a quote cannot end a value early", () => {
    expect(canonicalJson({ 'a"b': 'c"d' })).toBe('{"a\\"b":"c\\"d"}');
  });

  it("round-trips non-ASCII unchanged", () => {
    expect(JSON.parse(canonicalJson({ name: "Ada Lovelace — 💡" }))).toEqual({
      name: "Ada Lovelace — 💡",
    });
  });

  it.each([
    ["undefined in an object", { email: undefined }, /undefined/],
    ["NaN", { attempts: NaN }, /NaN/],
    ["Infinity", { attempts: Infinity }, /Infinity/],
    ["a bigint", { seq: 1n }, /bigint/],
    ["a Date", { at: new Date() }, /Date/],
    ["a function", { fn: () => 1 }, /function/],
  ])("refuses %s rather than hashing a guess", (_label, value, message) => {
    expect(() => canonicalJson(value)).toThrow(AuditEncodingError);
    expect(() => canonicalJson(value)).toThrow(message);
  });

  it("names the path to the offending value", () => {
    expect(() => canonicalJson({ a: [{ b: undefined }] })).toThrow("details.a[0].b");
  });

  it("writes finite numbers as JSON does, with -0 normalised to 0", () => {
    // `-0 === 0`, so nothing downstream can tell the two apart; hashing them
    // differently would make an entry fail to verify against a value the
    // application considers identical to the one it wrote.
    expect(canonicalJson({ a: 0, b: -0, c: 1.5, d: -2 })).toBe('{"a":0,"b":0,"c":1.5,"d":-2}');
  });

  it("accepts a null-prototype object, which is still just its own properties", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });

    expect(canonicalJson(bare)).toBe('{"a":1}');
  });
});

describe("auditEntryPreimage", () => {
  const base = {
    seq: 7n,
    occurredAt: new Date("2026-09-16T12:00:00.000Z"),
    action: "user.deleted",
    resourceType: "user",
    resourceId: "usr-1",
    details: { email: "gone@example.test" },
    actorId: "adm-1",
    actorRole: "ADMIN",
    correlationId: "corr-1",
    prevHash: GENESIS_HASH,
  };

  it("length-prefixes every field, so no value can impersonate a boundary", () => {
    // The classic preimage attack: with values merely concatenated, moving a
    // character from one field to the next produces identical bytes. The byte
    // length in front of each value removes the boundary as a degree of
    // freedom, and these two entries must therefore differ.
    const split = auditEntryPreimage({ ...base, resourceId: "usr", action: "1user.deleted" });
    const joined = auditEntryPreimage({ ...base, resourceId: "usr1", action: "user.deleted" });

    expect(split).not.toBe(joined);
  });

  it("counts bytes rather than characters", () => {
    // "é" is one character and two UTF-8 bytes. A length in characters would
    // make the prefix disagree with the bytes actually hashed.
    expect(auditEntryPreimage({ ...base, resourceId: "é" })).toContain("resourceId:2:é");
  });

  it("distinguishes a null field from an empty one", () => {
    expect(auditEntryPreimage({ ...base, actorId: null })).not.toBe(
      auditEntryPreimage({ ...base, actorId: "" }),
    );
  });

  it("encodes the timestamp as UTC to the millisecond, matching the column", () => {
    expect(auditEntryPreimage(base)).toContain("occurredAt:24:2026-09-16T12:00:00.000Z");
  });

  it("is versioned, so a future format change cannot be mistaken for tampering", () => {
    expect(auditEntryPreimage(base)).toMatch(/^version:\d+:audit-chain-v1\n/);
  });
});

describe("auditEntryHash", () => {
  const base = {
    seq: 1n,
    occurredAt: new Date("2026-09-16T12:00:00.000Z"),
    action: "user.deleted",
    resourceType: "user",
    resourceId: "usr-1",
    details: { email: "gone@example.test" },
    actorId: null,
    actorRole: null,
    correlationId: null,
    prevHash: GENESIS_HASH,
  };

  it("is SHA-256 over the preimage, and nothing else", () => {
    const expected = createHash("sha256").update(auditEntryPreimage(base), "utf8").digest("hex");

    expect(auditEntryHash(base)).toBe(expected);
    expect(isChainHash(auditEntryHash(base))).toBe(true);
  });

  it.each([
    ["seq", { seq: 2n }],
    ["occurredAt", { occurredAt: new Date("2026-09-16T12:00:00.001Z") }],
    ["action", { action: "user.registered" }],
    ["resourceType", { resourceType: "order" }],
    ["resourceId", { resourceId: "usr-2" }],
    ["details", { details: { email: "other@example.test" } }],
    ["actorId", { actorId: "adm-1" }],
    ["actorRole", { actorRole: "ADMIN" }],
    ["correlationId", { correlationId: "corr-1" }],
    ["prevHash", { prevHash: "a".repeat(64) }],
  ])("changes when %s changes", (_field, change) => {
    expect(auditEntryHash({ ...base, ...change })).not.toBe(auditEntryHash(base));
  });

  it("does not change when details are rebuilt in a different key order", () => {
    const one = auditEntryHash({ ...base, details: { a: 1, b: 2 } });
    const other = auditEntryHash({ ...base, details: { b: 2, a: 1 } });

    expect(one).toBe(other);
  });
});

describe("sealAuditEntry", () => {
  it("takes resourceType from the catalogue rather than from the caller", () => {
    const entry = sealAuditEntry(draft(), FIRST_SEQ, GENESIS_HASH);

    expect(entry.resourceType).toBe("user");
  });

  it("flattens the actor into the two columns, and null into both", () => {
    const byAdmin = sealAuditEntry(draft(), FIRST_SEQ, GENESIS_HASH);
    const bySystem = sealAuditEntry(draft({ actor: null }), FIRST_SEQ, GENESIS_HASH);

    expect([byAdmin.actorId, byAdmin.actorRole]).toEqual(["adm-1", "ADMIN"]);
    expect([bySystem.actorId, bySystem.actorRole]).toEqual([null, null]);
  });

  it("seals with a hash that recomputes from the sealed entry", () => {
    const entry = sealAuditEntry(draft(), 9n, "b".repeat(64));

    expect(auditEntryHash(entry)).toBe(entry.hash);
  });

  it("refuses a prevHash that is not a chain hash", () => {
    // Guards the one way a chain could be silently anchored on nothing: a
    // caller — or a future store — passing an empty string for "no previous
    // entry" instead of GENESIS_HASH.
    expect(() => sealAuditEntry(draft(), FIRST_SEQ, "")).toThrow(AuditEncodingError);
    expect(() => sealAuditEntry(draft(), FIRST_SEQ, "NOT-HEX".repeat(8))).toThrow(
      /not a chain hash/,
    );
  });

  it("accepts the genesis hash, which is not the hash of anything", () => {
    // Sixty-four zeros is unreachable as a SHA-256 output in practice, which is
    // what stops anything being spliced in front of the first entry.
    expect(() => sealAuditEntry(draft(), FIRST_SEQ, GENESIS_HASH)).not.toThrow();
  });

  it("refuses an action that is not in the catalogue", () => {
    expect(() =>
      sealAuditEntry({ ...draft(), action: "user.suspended" as never }, FIRST_SEQ, GENESIS_HASH),
    ).toThrow(/not in AUDIT_ACTIONS/);
  });
});
