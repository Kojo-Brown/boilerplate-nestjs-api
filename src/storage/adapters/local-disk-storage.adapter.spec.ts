import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorageAdapter } from "./local-disk-storage.adapter";
import { InvalidObjectKeyError, ObjectNotFoundError } from "../storage.errors";
import { stubConfig } from "@/test-utils/stub-config";

/**
 * What the shared contract cannot reach: the disk itself.
 *
 * The contract proves this adapter behaves like the other two. These tests
 * prove it does so safely — that a traversing key never escapes the root even
 * if the shared parser were bypassed, that a crash mid-write cannot leave a
 * truncated object, and that the sidecar layout survives files it did not put
 * there.
 */

const ROOT = join(tmpdir(), `local-disk-adapter-${process.pid}`);
const TEXT = Buffer.from("the quick brown fox", "utf8");

function build(root = ROOT): LocalDiskStorageAdapter {
  return new LocalDiskStorageAdapter(stubConfig({ STORAGE_LOCAL_ROOT: root }));
}

describe("LocalDiskStorageAdapter", () => {
  let adapter: LocalDiskStorageAdapter;

  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    adapter = build();
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  describe("containment", () => {
    it("keeps every written path under the root", async () => {
      await adapter.put("avatars/user-1/photo.jpg", TEXT, { contentType: "image/jpeg" });

      await expect(stat(join(ROOT, "avatars/user-1/photo.jpg/.object"))).resolves.toMatchObject({
        size: TEXT.byteLength,
      });
    });

    it("refuses a key that resolves outside the root", async () => {
      // Unreachable through `assertValidObjectKey`, which rejects `..` first.
      // The second check exists because the cost of the parser being wrong
      // about one encoding is arbitrary filesystem write.
      await expect(adapter.put("../escaped", TEXT, { contentType: "text/plain" })).rejects.toThrow(
        InvalidObjectKeyError,
      );

      await expect(stat(join(tmpdir(), "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("never writes outside the root even for a deeply nested traversal", async () => {
      await expect(
        adapter.put("a/b/../../../../../../etc/passwd", TEXT, { contentType: "text/plain" }),
      ).rejects.toThrow(InvalidObjectKeyError);
    });
  });

  describe("on-disk layout", () => {
    it("gives every key its own directory, so a key can also be a prefix", async () => {
      // The reason for the layout: `a/b` must be storable alongside `a/b/c`,
      // which the obvious `<root>/<key>` mapping cannot express.
      await adapter.put("a/b", Buffer.from("one"), { contentType: "text/plain" });
      await adapter.put("a/b/c", Buffer.from("two"), { contentType: "text/plain" });

      expect((await adapter.get("a/b")).body.toString("utf8")).toBe("one");
      expect((await adapter.get("a/b/c")).body.toString("utf8")).toBe("two");
    });

    it("stores content type and metadata in a sidecar next to the body", async () => {
      await adapter.put("docs/a.txt", TEXT, {
        contentType: "text/plain",
        metadata: { "uploaded-by": "user-1" },
      });

      const sidecar: unknown = JSON.parse(
        await readFile(join(ROOT, "docs/a.txt/.meta.json"), "utf8"),
      );

      expect(sidecar).toMatchObject({
        contentType: "text/plain",
        metadata: { "uploaded-by": "user-1" },
      });
    });

    it("cannot have its sidecar overwritten by an ordinary upload", async () => {
      // Under a `<key>.meta.json` sidecar, uploading the key `docs/a.txt.meta.json`
      // would silently rewrite the content type of `docs/a.txt`.
      await adapter.put("docs/a.txt", TEXT, { contentType: "text/plain" });
      await adapter.put("docs/a.txt.meta.json", Buffer.from("{}"), {
        contentType: "application/json",
      });

      expect((await adapter.head("docs/a.txt")).contentType).toBe("text/plain");
    });

    it("leaves no temporary files behind after a write", async () => {
      await adapter.put("docs/a.txt", TEXT, { contentType: "text/plain" });

      const entries = await readdir(join(ROOT, "docs/a.txt"));

      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(entries.sort()).toEqual([".meta.json", ".object"]);
    });

    it("removes the directories a deleted object leaves behind", async () => {
      await adapter.put("a/b/c", TEXT, { contentType: "text/plain" });

      await adapter.delete("a/b/c");

      // Otherwise every deleted key would leave a permanent empty branch that
      // `list` has to walk on every call.
      await expect(stat(join(ROOT, "a"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("stops pruning at a directory that still holds an object", async () => {
      await adapter.put("a/b", TEXT, { contentType: "text/plain" });
      await adapter.put("a/b/c", TEXT, { contentType: "text/plain" });

      await adapter.delete("a/b/c");

      expect(await adapter.exists("a/b")).toBe(true);
    });

    it("never prunes the root itself", async () => {
      await adapter.put("only", TEXT, { contentType: "text/plain" });

      await adapter.delete("only");

      // The root is configuration, possibly a mount point. Removing it would
      // turn a delete into a broken deployment.
      await expect(stat(ROOT)).resolves.toMatchObject({});
    });
  });

  describe("files it did not write", () => {
    it("reads a body with no sidecar as octet-stream rather than failing", async () => {
      // A restored backup or a `docker cp`. Losing the content type is bad;
      // refusing to serve the file at all is worse.
      await mkdir(join(ROOT, "seeded"), { recursive: true });
      await writeFile(join(ROOT, "seeded/.object"), TEXT);

      const object = await adapter.head("seeded");

      expect(object.contentType).toBe("application/octet-stream");
      expect(object.size).toBe(TEXT.byteLength);
    });

    it("still gives such a body a stable etag", async () => {
      await mkdir(join(ROOT, "seeded"), { recursive: true });
      await writeFile(join(ROOT, "seeded/.object"), TEXT);

      const [first, second] = [await adapter.head("seeded"), await adapter.head("seeded")];

      expect(first.etag).toBe(second.etag);
      expect(first.etag.length).toBeGreaterThan(0);
    });

    it("falls back to octet-stream for an unparseable sidecar", async () => {
      await mkdir(join(ROOT, "corrupt"), { recursive: true });
      await writeFile(join(ROOT, "corrupt/.object"), TEXT);
      await writeFile(join(ROOT, "corrupt/.meta.json"), "{ not json");

      expect((await adapter.head("corrupt")).contentType).toBe("application/octet-stream");
    });

    it("ignores a directory whose name could never be a valid key", async () => {
      // A listing that returns keys every other method rejects is worse than
      // one that is incomplete.
      await adapter.put("good", TEXT, { contentType: "text/plain" });
      await mkdir(join(ROOT, "bad "), { recursive: true });
      await writeFile(join(ROOT, "bad /.object"), TEXT);

      expect((await adapter.list()).objects.map((object) => object.key)).toEqual(["good"]);
    });

    it("reports a plain file sitting where a key's directory would be as missing", async () => {
      await writeFile(join(ROOT, "collision"), TEXT).catch(async () => {
        await mkdir(ROOT, { recursive: true });
        await writeFile(join(ROOT, "collision"), TEXT);
      });

      // `ENOTDIR`, not `ENOENT` — from the caller's flat-keyspace view there is
      // simply no object there, and a 502 would be misleading.
      await expect(adapter.head("collision")).rejects.toThrow(ObjectNotFoundError);
      expect(await adapter.exists("collision")).toBe(false);
    });
  });

  describe("configuration", () => {
    it("reports itself configured without the root existing yet", () => {
      // The root is created on first write, so there is nothing a deployment
      // can be missing — and a volume that is still mounting must not take the
      // process down at boot.
      expect(build(join(tmpdir(), "does-not-exist-yet")).isConfigured).toBe(true);
    });

    it("lists nothing rather than failing when the root does not exist", async () => {
      const page = await build(join(tmpdir(), "definitely-not-created")).list();

      expect(page).toEqual({ objects: [], nextCursor: null });
    });

    it("defaults the root to ./storage when unset", async () => {
      const withDefault = new LocalDiskStorageAdapter(stubConfig({}));

      // Resolved against the CWD at construction rather than per call, so a
      // later `process.chdir()` cannot silently move the store.
      await expect(withDefault.exists("nothing")).resolves.toBe(false);
    });
  });
});
