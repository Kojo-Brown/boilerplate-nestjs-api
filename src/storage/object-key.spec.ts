import { assertValidObjectKey, normaliseMetadata } from "./object-key";
import { InvalidObjectKeyError, InvalidObjectMetadataError } from "./storage.errors";
import { HttpStatus } from "@nestjs/common";

/**
 * The adapter contract already runs every rejected key through all three
 * backends. This file covers the parser itself: the shapes that are accepted,
 * the reason text each rejection carries, and the metadata rules — none of
 * which need a backend to exercise, and all of which are the difference between
 * a safe key and a filesystem escape.
 */
describe("assertValidObjectKey", () => {
  describe("accepts", () => {
    it.each([
      "photo.jpg",
      "avatars/user-1/photo.jpg",
      "a/b/c/d/e/f",
      "with spaces inside.txt",
      "unicode-café-🙂.txt",
      "dot.in.the.middle.tar.gz",
      "..leading-dots-in-a-name",
      "a..b",
      "1234567890",
    ])("%p", (key) => {
      expect(assertValidObjectKey(key)).toBe(key);
    });

    it("returns the key unchanged rather than a normalised copy", () => {
      // Callers use the return value as the storage key, so any silent
      // rewriting here would mean the key they asked for is not the key stored.
      const key = "avatars/user-1/photo.jpg";

      expect(assertValidObjectKey(key)).toBe(key);
    });
  });

  describe("rejects", () => {
    it.each([
      ["", "non-empty"],
      ["..", "'.' or '..'"],
      ["../secrets", "'.' or '..'"],
      ["a/../b", "'.' or '..'"],
      ["./a", "'.' or '..'"],
      ["/absolute", "not start with '/'"],
      ["a//b", "empty path segment"],
      ["a/", "not end with '/'"],
      ["back\\slash", "backslash"],
      [" leading", "leading or trailing spaces"],
      ["trailing ", "leading or trailing spaces"],
      ["a/ b/c", "leading or trailing spaces"],
      ["C:/windows/system32", "drive letter"],
      ["c:relative", "drive letter"],
    ])("%p because the key must be %s", (key, reason) => {
      expect(() => assertValidObjectKey(key)).toThrow(InvalidObjectKeyError);
      expect(() => assertValidObjectKey(key)).toThrow(new RegExp(escapeRegExp(reason)));
    });

    it.each([
      ["a\u0000b", "NUL"],
      ["a\u001Fb", "unit separator"],
      ["a\u007Fb", "DEL"],
      ["line\nbreak", "newline"],
    ])("%p (%s) as a control character", (key) => {
      expect(() => assertValidObjectKey(key)).toThrow(/control characters/);
    });

    it("a key whose bytes exceed 1024 even though its characters do not", () => {
      // 600 four-byte emoji: 600 characters, 2400 bytes. A length check on the
      // string would have let this through and S3 would have refused it.
      const key = "🙂".repeat(150) + "/" + "🙂".repeat(150);

      expect(Buffer.byteLength(key, "utf8")).toBeGreaterThan(1024);
      expect(() => assertValidObjectKey(key)).toThrow(/1024-byte limit/);
    });

    it("a segment over 255 bytes, which S3 allows and a filesystem does not", () => {
      expect(() => assertValidObjectKey("a".repeat(256))).toThrow(/255-byte limit/);
    });
  });

  it("reports a 400, because a bad key is the caller's input", () => {
    // Not a 500: nothing is broken, the request was wrong.
    try {
      assertValidObjectKey("../etc/passwd");
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidObjectKeyError);
      expect((error as InvalidObjectKeyError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});

describe("normaliseMetadata", () => {
  it("returns an empty object when there is no metadata", () => {
    expect(normaliseMetadata(undefined)).toEqual({});
  });

  it("lower-cases keys, because that is how S3 returns them", () => {
    expect(normaliseMetadata({ UploadedBy: "user-1" })).toEqual({ uploadedby: "user-1" });
  });

  it("preserves value case", () => {
    expect(normaliseMetadata({ origin: "WebApp" })).toEqual({ origin: "WebApp" });
  });

  it("rejects two keys that collide once lower-cased", () => {
    // Which one survived would otherwise depend on property order.
    expect(() => normaliseMetadata({ Origin: "a", origin: "b" })).toThrow(
      InvalidObjectMetadataError,
    );
  });

  it.each([
    ["a key with a space", { "uploaded by": "x" }],
    ["a key with an underscore", { uploaded_by: "x" }],
    ["a key starting with a hyphen", { "-leading": "x" }],
    ["an empty key", { "": "x" }],
  ])("rejects %s, since it becomes an HTTP header name", (_label, metadata) => {
    expect(() => normaliseMetadata(metadata)).toThrow(InvalidObjectMetadataError);
  });

  it("accepts alphanumeric keys with internal hyphens", () => {
    expect(normaliseMetadata({ "uploaded-by-v2": "user-1" })).toEqual({
      "uploaded-by-v2": "user-1",
    });
  });

  it.each([["café"], ["emoji 🙂"], ["tab\there"], ["null\u0000byte"]])(
    "rejects the non-ASCII or control value %p",
    (value) => {
      expect(() => normaliseMetadata({ note: value })).toThrow(/printable ASCII/);
    },
  );

  it("counts keys and values together against the 2 KB limit", () => {
    // The two values are 2048 bytes exactly — at the limit, not over it. Only
    // counting the one-byte keys as well pushes this to 2050, which is how S3
    // measures it.
    const metadata = { a: "x".repeat(1024), b: "y".repeat(1024) };

    expect(() => normaliseMetadata(metadata)).toThrow(/2048-byte limit/);
  });

  it("accepts metadata just under the limit", () => {
    expect(normaliseMetadata({ a: "x".repeat(2046) })).toEqual({ a: "x".repeat(2046) });
  });

  it("reports a 400, because bad metadata is the caller's input", () => {
    try {
      normaliseMetadata({ "bad key": "x" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidObjectMetadataError);
      expect((error as InvalidObjectMetadataError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
