import {
  InvalidObjectKeyError,
  InvalidObjectMetadataError,
  ObjectNotFoundError,
} from "./storage.errors";
import { STORAGE_ADAPTER_NAMES } from "./ports";
import type { StorageAdapter } from "./ports";

/**
 * The behavioural contract every storage adapter must satisfy.
 *
 * `StorageService` selects an adapter from an environment variable, so
 * everything downstream must behave identically whichever one it gets (LSP).
 * The type system only checks eight member signatures; what actually breaks an
 * upload is behaviour — an adapter that resolves with an empty buffer for a
 * missing key instead of throwing, one that returns `undefined` where another
 * returns `null` for the last page, one that quietly accepts `../../etc/passwd`
 * because a `Map` has no directories to escape from.
 *
 * So the contract lives here once and `storage-adapter.contract.spec.ts` runs
 * it against all three: the in-memory one directly, the local one against a
 * real temporary directory, and the S3 one against an in-process fake of the S3
 * HTTP API so the SDK's own signing, serialisation and XML parsing are in the
 * path. Adding an adapter means adding one line there.
 *
 * The harness supplies the adapter and a reset, because "start from empty" is
 * the one thing that genuinely differs: a `Map.clear()`, an `rm -rf`, a fresh
 * fake bucket.
 */
export interface StorageAdapterHarness {
  readonly adapter: StorageAdapter;
  /** Returns the backend to empty. Called before every test. */
  reset(): Promise<void> | void;
}

const TEXT = Buffer.from("the quick brown fox", "utf8");
const CONTENT_TYPE = "text/plain";

/**
 * Keys no adapter may accept.
 *
 * Every one of these is harmless in a flat keyspace and dangerous on a disk,
 * which is the whole reason validation is shared rather than per-adapter: if
 * the in-memory adapter accepted them, a test suite running against it would
 * certify behaviour that becomes a path traversal in production.
 */
const REJECTED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["../etc/passwd", "parent traversal"],
  ["a/../../etc/passwd", "traversal through a valid prefix"],
  ["/etc/passwd", "absolute path"],
  ["a//b", "empty segment"],
  ["a/./b", "current-directory segment"],
  ["a\\b", "backslash separator"],
  ["", "empty key"],
  ["trailing/", "trailing slash"],
  ["a/ b", "leading space in a segment"],
  ["C:/windows", "drive letter"],
];

export function describeStorageAdapterContract(
  name: string,
  createHarness: () => StorageAdapterHarness,
): void {
  describe(`${name} (storage adapter contract)`, () => {
    let adapter: StorageAdapter;

    beforeEach(async () => {
      const harness = createHarness();
      adapter = harness.adapter;
      await harness.reset();
    });

    describe("identity", () => {
      it("declares one of the registered adapter names", () => {
        expect(STORAGE_ADAPTER_NAMES).toContain(adapter.name);
      });

      it("reports whether it is configured without throwing", () => {
        expect(typeof adapter.isConfigured).toBe("boolean");
      });
    });

    describe("put() then get()", () => {
      it("returns the bytes that went in", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        const stored = await adapter.get("docs/note.txt");

        expect(stored.body.equals(TEXT)).toBe(true);
      });

      it("preserves the content type", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        expect((await adapter.get("docs/note.txt")).contentType).toBe(CONTENT_TYPE);
      });

      it("reports the byte length, not the character length", async () => {
        // "é" is two bytes in UTF-8 and one character. An adapter measuring the
        // string would disagree with the bytes S3 actually stored.
        const accented = Buffer.from("café", "utf8");
        await adapter.put("docs/accented.txt", accented, { contentType: CONTENT_TYPE });

        expect((await adapter.head("docs/accented.txt")).size).toBe(accented.byteLength);
      });

      it("round-trips binary content unchanged", async () => {
        const binary = Buffer.from([0x00, 0xff, 0x1f, 0x7f, 0x80, 0x0a, 0x0d]);
        await adapter.put("blobs/bin", binary, { contentType: "application/octet-stream" });

        expect((await adapter.get("blobs/bin")).body.equals(binary)).toBe(true);
      });

      it("stores a zero-byte object as an object, not as an absence", async () => {
        await adapter.put("empty", Buffer.alloc(0), { contentType: CONTENT_TYPE });

        expect(await adapter.exists("empty")).toBe(true);
        expect((await adapter.get("empty")).body.byteLength).toBe(0);
      });

      it("round-trips user metadata with lower-cased keys", async () => {
        await adapter.put("docs/note.txt", TEXT, {
          contentType: CONTENT_TYPE,
          metadata: { "uploaded-by": "user-1", Origin: "web" },
        });

        expect((await adapter.head("docs/note.txt")).metadata).toEqual({
          "uploaded-by": "user-1",
          origin: "web",
        });
      });

      it("reports an etag the caller can compare for equality", async () => {
        const written = await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });
        const read = await adapter.head("docs/note.txt");

        // Not "is an MD5" — the port promises only that the same object gives
        // the same token, which is what a caller conditioning on it needs.
        expect(read.etag).toBe(written.etag);
        expect(written.etag.length).toBeGreaterThan(0);
      });

      it("overwrites unconditionally, last writer wins", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });
        const replacement = Buffer.from("replaced", "utf8");

        await adapter.put("docs/note.txt", replacement, { contentType: "text/markdown" });
        const stored = await adapter.get("docs/note.txt");

        expect(stored.body.equals(replacement)).toBe(true);
        expect(stored.contentType).toBe("text/markdown");
        expect(stored.size).toBe(replacement.byteLength);
      });

      it("does not let the caller mutate stored bytes through the buffer it passed in", async () => {
        const mutable = Buffer.from("original", "utf8");
        await adapter.put("docs/mutable.txt", mutable, { contentType: CONTENT_TYPE });

        mutable.write("XXXXXXXX");

        // The in-memory adapter is the one that could plausibly fail this, and
        // it is the one every other test suite runs against — so a caller who
        // reuses a buffer must not see different behaviour in production.
        expect((await adapter.get("docs/mutable.txt")).body.toString("utf8")).toBe("original");
      });

      it("keeps keys that share a prefix separate", async () => {
        await adapter.put("a/b", Buffer.from("one"), { contentType: CONTENT_TYPE });
        await adapter.put("a/b/c", Buffer.from("two"), { contentType: CONTENT_TYPE });

        // A flat keyspace allows this; a filesystem has to make "a/b" both a
        // file and a directory, and cannot. The adapter must not lose the
        // first object or corrupt the second.
        expect((await adapter.get("a/b/c")).body.toString("utf8")).toBe("two");
      });
    });

    describe("getStream()", () => {
      it("streams the same bytes get() returns", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        const { object, body } = await adapter.getStream("docs/note.txt");
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));

        expect(Buffer.concat(chunks).equals(TEXT)).toBe(true);
        expect(object.key).toBe("docs/note.txt");
        expect(object.contentType).toBe(CONTENT_TYPE);
      });

      it("rejects for a missing key rather than emitting an error event", async () => {
        // A caller that has already started piping cannot recover from a late
        // error event as cleanly as from a rejected promise, so the failure has
        // to arrive before the stream is handed over.
        await expect(adapter.getStream("no/such/key")).rejects.toThrow(ObjectNotFoundError);
      });
    });

    describe("head() and exists()", () => {
      it("reports metadata without the body", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        const object = await adapter.head("docs/note.txt");

        expect(object).toMatchObject({ key: "docs/note.txt", size: TEXT.byteLength });
        expect(object.lastModified).toBeInstanceOf(Date);
        expect(Number.isNaN(object.lastModified.getTime())).toBe(false);
      });

      it("throws ObjectNotFoundError for a missing key", async () => {
        await expect(adapter.head("no/such/key")).rejects.toThrow(ObjectNotFoundError);
      });

      it("returns false from exists() rather than throwing", async () => {
        expect(await adapter.exists("no/such/key")).toBe(false);
      });

      it("returns true from exists() for a stored key", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        expect(await adapter.exists("docs/note.txt")).toBe(true);
      });
    });

    describe("get() for a missing key", () => {
      it("throws rather than resolving with an empty body", async () => {
        // An empty buffer would be indistinguishable from a zero-byte object
        // that really exists, which the suite above proves is a legal thing to
        // store.
        await expect(adapter.get("no/such/key")).rejects.toThrow(ObjectNotFoundError);
      });
    });

    describe("delete()", () => {
      it("removes the object", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        await adapter.delete("docs/note.txt");

        expect(await adapter.exists("docs/note.txt")).toBe(false);
      });

      it("is idempotent for a key that was never there", async () => {
        await expect(adapter.delete("no/such/key")).resolves.toBeUndefined();
      });

      it("is idempotent when called twice", async () => {
        await adapter.put("docs/note.txt", TEXT, { contentType: CONTENT_TYPE });

        await adapter.delete("docs/note.txt");

        await expect(adapter.delete("docs/note.txt")).resolves.toBeUndefined();
      });

      it("leaves neighbouring keys alone", async () => {
        await adapter.put("a/one", TEXT, { contentType: CONTENT_TYPE });
        await adapter.put("a/two", TEXT, { contentType: CONTENT_TYPE });

        await adapter.delete("a/one");

        expect(await adapter.exists("a/two")).toBe(true);
      });
    });

    describe("list()", () => {
      beforeEach(async () => {
        for (const key of ["a/1", "a/2", "a/3", "b/1"]) {
          await adapter.put(key, TEXT, { contentType: CONTENT_TYPE });
        }
      });

      it("returns every key when unfiltered", async () => {
        const page = await adapter.list();

        expect(page.objects.map((object) => object.key)).toEqual(["a/1", "a/2", "a/3", "b/1"]);
      });

      it("filters by prefix", async () => {
        const page = await adapter.list({ prefix: "a/" });

        expect(page.objects.map((object) => object.key)).toEqual(["a/1", "a/2", "a/3"]);
      });

      it("returns keys in lexicographic order", async () => {
        const keys = (await adapter.list()).objects.map((object) => object.key);

        expect(keys).toEqual([...keys].sort());
      });

      it("returns null — never undefined — for nextCursor on the last page", async () => {
        // Callers loop on `while (cursor)`. An adapter returning `undefined`
        // works until someone writes `cursor !== null`.
        expect((await adapter.list()).nextCursor).toBeNull();
      });

      it("pages through every key exactly once", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;

        do {
          const page: Awaited<ReturnType<StorageAdapter["list"]>> = await adapter.list({
            limit: 2,
            ...(cursor === null ? {} : { cursor }),
          });
          seen.push(...page.objects.map((object) => object.key));
          cursor = page.nextCursor;
        } while (cursor !== null);

        expect(seen).toEqual(["a/1", "a/2", "a/3", "b/1"]);
      });

      it("reports a cursor when more keys remain", async () => {
        const page = await adapter.list({ limit: 2 });

        expect(page.objects).toHaveLength(2);
        expect(page.nextCursor).toEqual(expect.any(String));
      });

      it("returns an empty page for a prefix that matches nothing", async () => {
        const page = await adapter.list({ prefix: "nothing/" });

        expect(page.objects).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it("reports a usable size for every listed object", async () => {
        const page = await adapter.list({ prefix: "a/" });

        for (const object of page.objects) {
          expect(object.size).toBe(TEXT.byteLength);
        }
      });
    });

    describe("key validation", () => {
      it.each(REJECTED_KEYS)("rejects %p (%s) on put", async (key) => {
        await expect(adapter.put(key, TEXT, { contentType: CONTENT_TYPE })).rejects.toThrow(
          InvalidObjectKeyError,
        );
      });

      it.each(REJECTED_KEYS)("rejects %p (%s) on get", async (key) => {
        await expect(adapter.get(key)).rejects.toThrow(InvalidObjectKeyError);
      });

      it.each(REJECTED_KEYS)("rejects %p (%s) on delete", async (key) => {
        // Notably including delete: a traversing key that only `put` rejected
        // would still let a caller remove an arbitrary file.
        await expect(adapter.delete(key)).rejects.toThrow(InvalidObjectKeyError);
      });

      it("rejects a key containing a NUL byte", async () => {
        await expect(
          adapter.put("a\u0000/../../etc/passwd", TEXT, { contentType: CONTENT_TYPE }),
        ).rejects.toThrow(InvalidObjectKeyError);
      });

      it("rejects a key over the 1024-byte limit", async () => {
        const tooLong = Array.from({ length: 5 }, () => "k".repeat(250)).join("/");
        await expect(adapter.put(tooLong, TEXT, { contentType: CONTENT_TYPE })).rejects.toThrow(
          InvalidObjectKeyError,
        );
      });

      it("accepts a key at the 1024-byte limit", async () => {
        // Four 255-byte segments plus separators: the largest key that is legal
        // for both a bucket and a filesystem.
        const longest = Array.from({ length: 4 }, () => "k".repeat(255)).join("/");
        expect(Buffer.byteLength(longest, "utf8")).toBe(1023);

        await expect(
          adapter.put(longest, TEXT, { contentType: CONTENT_TYPE }),
        ).resolves.toMatchObject({ size: TEXT.byteLength });
      });

      it("rejects a segment over the 255-byte limit even when the whole key fits", async () => {
        // Legal in S3, `ENAMETOOLONG` on every mainstream filesystem. Rejecting
        // it everywhere is what keeps the adapters interchangeable.
        await expect(
          adapter.put("k".repeat(256), TEXT, { contentType: CONTENT_TYPE }),
        ).rejects.toThrow(InvalidObjectKeyError);
      });
    });

    describe("metadata validation", () => {
      it("rejects a metadata key that is not a legal header name", async () => {
        await expect(
          adapter.put("docs/note.txt", TEXT, {
            contentType: CONTENT_TYPE,
            metadata: { "bad key": "value" },
          }),
        ).rejects.toThrow(InvalidObjectMetadataError);
      });

      it("rejects a non-ASCII metadata value", async () => {
        // Legal in a `Map`, silently mangled by S3's header encoding.
        await expect(
          adapter.put("docs/note.txt", TEXT, {
            contentType: CONTENT_TYPE,
            metadata: { name: "café" },
          }),
        ).rejects.toThrow(InvalidObjectMetadataError);
      });

      it("rejects metadata over the 2 KB limit", async () => {
        await expect(
          adapter.put("docs/note.txt", TEXT, {
            contentType: CONTENT_TYPE,
            metadata: { big: "x".repeat(2049) },
          }),
        ).rejects.toThrow(InvalidObjectMetadataError);
      });
    });
  });
}
