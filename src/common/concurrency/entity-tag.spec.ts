import { BadRequestException } from "@nestjs/common";
import { describeMismatch, formatEntityTag, isSatisfiedBy, parseIfMatch } from "./entity-tag";
import type { ExpectedVersion } from "./entity-tag";

describe("formatEntityTag()", () => {
  it("quotes the version as a strong entity-tag", () => {
    expect(formatEntityTag(0)).toBe('"0"');
    expect(formatEntityTag(42)).toBe('"42"');
  });

  it("round-trips through the parser", () => {
    const parsed = parseIfMatch(formatEntityTag(7));

    expect(isSatisfiedBy(parsed, 7)).toBe(true);
  });
});

describe("parseIfMatch()", () => {
  it("reads `*` as any current version", () => {
    expect(parseIfMatch("*")).toEqual({ mode: "any" });
  });

  it("reads a single strong tag", () => {
    expect(parseIfMatch('"3"')).toEqual({
      mode: "list",
      tags: [{ weak: false, opaque: "3", version: 3 }],
    });
  });

  it("reads a comma-separated list", () => {
    const parsed = parseIfMatch('"3", "4",  "5"');

    expect(parsed).toMatchObject({ mode: "list" });
    expect(parsed).toEqual({
      mode: "list",
      tags: [
        { weak: false, opaque: "3", version: 3 },
        { weak: false, opaque: "4", version: 4 },
        { weak: false, opaque: "5", version: 5 },
      ],
    });
  });

  it("marks a weak tag rather than rejecting it", () => {
    expect(parseIfMatch('W/"3"')).toEqual({
      mode: "list",
      tags: [{ weak: true, opaque: "3", version: 3 }],
    });
  });

  it("keeps a comma inside a tag as part of that tag", () => {
    // `,` is a legal etagc. Splitting on it would turn one tag into two
    // unmatchable halves and 412 a request that should have gone through.
    expect(parseIfMatch('"a,b"')).toEqual({
      mode: "list",
      tags: [{ weak: false, opaque: "a,b", version: null }],
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseIfMatch('  "3"  ')).toMatchObject({
      tags: [{ opaque: "3" }],
    });
  });

  it("records a tag it cannot read as a version rather than rejecting the request", () => {
    // A validator from another scheme is syntactically fine. It simply cannot
    // match, which is a failed precondition (412), not a malformed one (400).
    expect(parseIfMatch('"9f8b2c"')).toEqual({
      mode: "list",
      tags: [{ weak: false, opaque: "9f8b2c", version: null }],
    });
  });

  it.each([
    ["a leading zero", '"03"'],
    ["a negative number", '"-1"'],
    ["a decimal", '"1.5"'],
    ["an integer beyond Number.MAX_SAFE_INTEGER", '"9007199254740993"'],
  ])("does not read %s as a version", (_case, header) => {
    expect(parseIfMatch(header)).toMatchObject({ tags: [{ version: null }] });
  });

  it.each([
    ["an empty field", ""],
    ["whitespace only", "   "],
    ["an unquoted token", "3"],
    ["an unterminated tag", '"3'],
    ["a missing separator", '"3" "4"'],
    ["a trailing comma with nothing after it", '"3",'],
    ["`*` mixed into a list", '"3", *'],
  ])("rejects %s", (_case, header) => {
    expect(() => parseIfMatch(header)).toThrow(BadRequestException);
  });
});

describe("isSatisfiedBy()", () => {
  const listOf = (...versions: number[]): ExpectedVersion => ({
    mode: "list",
    tags: versions.map((version) => ({ weak: false, opaque: String(version), version })),
  });

  it("is always satisfied when no If-Match was sent", () => {
    expect(isSatisfiedBy({ mode: "unconditional" }, 9)).toBe(true);
  });

  it("is satisfied by any version for `*`", () => {
    expect(isSatisfiedBy({ mode: "any" }, 0)).toBe(true);
    expect(isSatisfiedBy({ mode: "any" }, 9)).toBe(true);
  });

  it("matches an exact version", () => {
    expect(isSatisfiedBy(listOf(3), 3)).toBe(true);
    expect(isSatisfiedBy(listOf(3), 4)).toBe(false);
  });

  it("matches version 0, which is falsy and easy to lose", () => {
    expect(isSatisfiedBy(listOf(0), 0)).toBe(true);
  });

  it("is satisfied when any one tag in the list matches", () => {
    expect(isSatisfiedBy(listOf(1, 2, 3), 2)).toBe(true);
    expect(isSatisfiedBy(listOf(1, 2, 3), 4)).toBe(false);
  });

  it("is never satisfied by a weak tag, even one naming the current version", () => {
    // RFC 9110 §13.1.1 requires the strong comparison function for If-Match.
    expect(isSatisfiedBy(parseIfMatch('W/"3"'), 3)).toBe(false);
  });

  it("ignores a weak tag but still honours a strong one beside it", () => {
    expect(isSatisfiedBy(parseIfMatch('W/"3", "4"'), 4)).toBe(true);
  });

  it("is never satisfied by a tag this server could not have issued", () => {
    expect(isSatisfiedBy(parseIfMatch('"9f8b2c"'), 3)).toBe(false);
  });
});

describe("describeMismatch()", () => {
  it("names the current version so the client knows what to re-read", () => {
    expect(describeMismatch(parseIfMatch('"3"'), 5)).toContain('"5"');
  });

  it("echoes what was sent", () => {
    expect(describeMismatch(parseIfMatch('"3"'), 5)).toContain('sent "3"');
  });

  it("explains a weak tag rather than leaving the client to guess", () => {
    // Without this the response is a 412 against the exact version the client
    // is holding, which reads as a server bug.
    expect(describeMismatch(parseIfMatch('W/"5"'), 5)).toContain("weak entity-tag");
  });
});
