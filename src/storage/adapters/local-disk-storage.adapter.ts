import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { assertValidObjectKey, normaliseMetadata } from "../object-key";
import { clampListLimit } from "../list-options";
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  StorageOperationError,
} from "../storage.errors";
import type {
  ListObjectsOptions,
  ListObjectsPage,
  PutObjectOptions,
  StorageAdapter,
  StorageObject,
  StorageObjectBody,
} from "../ports";

/**
 * Every key becomes a directory holding these two files.
 *
 * The obvious layout — key `a/b` at `<root>/a/b` — cannot represent a flat
 * keyspace, because S3 lets `a/b` and `a/b/c` both be objects and a filesystem
 * needs `a/b` to be a file for one and a directory for the other. That is not a
 * hypothetical: `avatars/<id>` and `avatars/<id>/thumb` is an ordinary pair of
 * keys, and under the obvious layout the second upload fails with `ENOTDIR`
 * against the disk and succeeds against S3.
 *
 * Giving every key its own directory removes the conflict entirely: `a/b` is
 * `<root>/a/b/.object` and `a/b/c` is `<root>/a/b/c/.object`, which are
 * different paths that nest happily. It also removes a second hazard for free —
 * with a `<key>.meta.json` sidecar, uploading the key `a.meta.json` would have
 * silently rewritten the metadata of the object `a`.
 *
 * The cost is an inode per object and directories left behind on delete, which
 * `pruneEmptyParents` cleans up.
 */
const BODY_FILE = ".object";
const SIDECAR_FILE = ".meta.json";

interface Sidecar {
  readonly contentType: string;
  readonly metadata: Record<string, string>;
  readonly cacheControl?: string;
  /**
   * Content hash, computed once at write time.
   *
   * Recorded rather than recomputed on read because `head` must return the same
   * ETag `put` did — the port promises equality comparison works — and hashing
   * on read would make a 1000-key `list` read 1000 whole files.
   */
  readonly etag?: string;
}

/**
 * An object store on the local filesystem.
 *
 * The realistic backend for a single-node deployment, a docker-compose stack,
 * or an integration test that wants real bytes on a real disk without a bucket.
 * It is not a substitute for S3 in a replicated deployment: two API pods do not
 * share a disk, so an object written by one is a 404 from the other. That is a
 * property of the deployment rather than a bug here, and `StorageService` warns
 * when this adapter is selected in production for exactly that reason.
 *
 * Two more things a filesystem does not give you, beyond the flat keyspace the
 * layout above buys back:
 *
 * **Content type and user metadata** have nowhere to live. Extended attributes
 * are the tempting answer and are not portable — unavailable on many container
 * filesystems, and silently dropped by `docker cp` and most archive formats. So
 * each object carries a JSON sidecar, and a missing or unparseable one degrades
 * to `application/octet-stream` rather than making the object unreadable:
 * losing the content type is bad, losing the file is worse.
 *
 * **Atomic replacement.** `writeFile` truncates first, so a concurrent reader
 * can see a half-written object and a crash mid-write leaves one permanently.
 * Every write goes to a temporary file in the same directory and is `rename`d
 * into place, which is atomic within a filesystem.
 */
@Injectable()
export class LocalDiskStorageAdapter implements StorageAdapter {
  readonly name = "local" as const;

  private readonly logger = new Logger(LocalDiskStorageAdapter.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    // Resolved once at construction against the process CWD. A relative root
    // re-resolved per call would follow a `process.chdir()` and start writing
    // somewhere else, and the containment check below would still pass.
    this.root = resolve(config.get<string>("STORAGE_LOCAL_ROOT") ?? "./storage");
  }

  /**
   * Always true: the root is created on first write rather than required to
   * exist, so there is no configuration for a deployment to be missing.
   *
   * A directory that cannot be created is a real failure, but an operational
   * one — it surfaces as a 502 from the call that needed it, rather than taking
   * the whole process down at boot over a volume that may still be mounting.
   */
  readonly isConfigured = true;

  async put(key: string, body: Buffer, options: PutObjectOptions): Promise<StorageObject> {
    const directory = this.directoryFor(key);
    const metadata = normaliseMetadata(options.metadata);

    const sidecar: Sidecar = {
      contentType: options.contentType,
      metadata,
      etag: etagOf(body),
      ...(options.cacheControl === undefined ? {} : { cacheControl: options.cacheControl }),
    };

    // `randomUUID` rather than a counter: two processes sharing the root would
    // otherwise collide on the temporary name, and each would rename the
    // other's half-written bytes into place.
    const tempPath = join(directory, `${randomUUID()}.tmp`);
    const bodyPath = join(directory, BODY_FILE);

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(tempPath, body);
      // Sidecar first. A body with a stale sidecar has the wrong content type;
      // a body with no sidecar reads as octet-stream. Both are recoverable, and
      // neither is a missing object.
      await writeFile(join(directory, SIDECAR_FILE), JSON.stringify(sidecar), "utf8");
      await rename(tempPath, bodyPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw this.operationError("put", key, error);
    }

    const stats = await stat(bodyPath);
    return {
      key,
      size: stats.size,
      contentType: sidecar.contentType,
      etag: etagOf(body),
      lastModified: new Date(stats.mtimeMs),
      metadata,
    };
  }

  async get(key: string): Promise<StorageObjectBody> {
    const object = await this.head(key);

    try {
      return { ...object, body: await readFile(join(this.directoryFor(key), BODY_FILE)) };
    } catch (error) {
      // It existed for `head` and does not now: a concurrent delete. Reported
      // as not-found rather than as a backend failure, because that is what a
      // caller retrying would find.
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw this.operationError("get", key, error);
    }
  }

  async getStream(key: string): Promise<{ object: StorageObject; body: Readable }> {
    const object = await this.head(key);
    const stream = createReadStream(join(this.directoryFor(key), BODY_FILE));

    // `createReadStream` opens lazily, so a file deleted between `head` and the
    // first read surfaces as an `error` event rather than a rejection here.
    // Waiting for `open` turns it back into a rejected promise, which is what
    // the port promises and what a caller can actually handle — once piping has
    // started, a late error event is much harder to recover from.
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stream.once("open", () => resolvePromise());
      stream.once("error", (error: NodeJS.ErrnoException) => {
        stream.destroy();
        rejectPromise(
          isNotFound(error)
            ? new ObjectNotFoundError(key)
            : this.operationError("getStream", key, error),
        );
      });
    });

    return { object, body: stream };
  }

  async head(key: string): Promise<StorageObject> {
    const directory = this.directoryFor(key);

    let stats;
    try {
      stats = await stat(join(directory, BODY_FILE));
    } catch (error) {
      if (isNotFound(error) || isNotADirectory(error)) throw new ObjectNotFoundError(key);
      throw this.operationError("head", key, error);
    }

    if (!stats.isFile()) throw new ObjectNotFoundError(key);

    const sidecar = await this.readSidecar(directory);
    return {
      key,
      size: stats.size,
      contentType: sidecar.contentType,
      etag: sidecar.etag ?? syntheticEtag(stats.size, stats.mtimeMs),
      lastModified: new Date(stats.mtimeMs),
      metadata: sidecar.metadata,
    };
  }

  async exists(key: string): Promise<boolean> {
    const directory = this.directoryFor(key);
    try {
      return (await stat(join(directory, BODY_FILE))).isFile();
    } catch (error) {
      if (isNotFound(error) || isNotADirectory(error)) return false;
      throw this.operationError("exists", key, error);
    }
  }

  async delete(key: string): Promise<void> {
    const directory = this.directoryFor(key);
    try {
      // `force` makes this idempotent, matching S3's DeleteObject.
      await rm(join(directory, BODY_FILE), { force: true });
      await rm(join(directory, SIDECAR_FILE), { force: true });
    } catch (error) {
      if (isNotADirectory(error)) return;
      throw this.operationError("delete", key, error);
    }

    await this.pruneEmptyParents(directory);
  }

  async list(options: ListObjectsOptions = {}): Promise<ListObjectsPage> {
    const limit = clampListLimit(options.limit);
    const prefix = options.prefix ?? "";

    let keys: string[];
    try {
      keys = await this.walk(this.root, "");
    } catch (error) {
      // Nothing has been written yet, so the root does not exist. An empty
      // listing is the truthful answer, not a failure.
      if (isNotFound(error)) return { objects: [], nextCursor: null };
      throw this.operationError("list", prefix, error);
    }

    const matching = keys
      .filter(
        (key) => key.startsWith(prefix) && (options.cursor === undefined || key > options.cursor),
      )
      .sort();

    const page = matching.slice(0, limit);
    // A `head` per key is the honest cost of a filesystem listing: `readdir`
    // gives names, while size and content type live in the inode and the
    // sidecar. The page is bounded by `limit`, so this is bounded work.
    const objects = await Promise.all(page.map((key) => this.head(key)));
    const last = page.at(-1);

    return { objects, nextCursor: matching.length > limit && last ? last : null };
  }

  /**
   * Maps a key to its directory and proves the result stays under the root.
   *
   * `assertValidObjectKey` has already rejected `..` segments, backslashes and
   * NUL bytes, so this check should be unreachable. It is here anyway because
   * the cost of being wrong is arbitrary filesystem read and write, and because
   * the two checks fail for independent reasons: that one parses the key, this
   * one asks the path module what the key actually resolved to.
   */
  private directoryFor(key: string): string {
    assertValidObjectKey(key);

    const path = resolve(join(this.root, key));
    const inside = relative(this.root, path);

    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) {
      throw new InvalidObjectKeyError(key, "key resolves outside the storage root");
    }

    return path;
  }

  /** Every object key under `dir`, relative to the root. */
  private async walk(dir: string, keyPrefix: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const keys: string[] = [];

    // A directory holding a body file *is* an object, and may still contain
    // further object directories beneath it — that is the whole point of the
    // layout, so both branches run rather than one or the other.
    if (entries.some((entry) => entry.name === BODY_FILE && entry.isFile()) && keyPrefix !== "") {
      // The root can hold files this adapter did not write — a mounted volume,
      // a restored backup. A directory name that is not a legal key is skipped
      // rather than listed, because every other method would reject that key
      // and a listing full of unfetchable entries is worse than an incomplete
      // one.
      if (isListableKey(keyPrefix)) keys.push(keyPrefix);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // `path.posix.join` rather than `path.join`: these are keys being
      // reassembled, not paths, and on Windows the platform join would hand
      // back "a\b" for a key that went in as "a/b".
      const key = keyPrefix === "" ? entry.name : posix.join(keyPrefix, entry.name);
      keys.push(...(await this.walk(join(dir, entry.name), key)));
    }

    return keys;
  }

  /**
   * Removes the now-empty directories a deleted object left behind, stopping at
   * the root or at the first directory that still holds something.
   *
   * `rmdir` on a non-empty directory fails, which is exactly the check needed —
   * and makes this safe under concurrency, since a sibling upload that recreates
   * the directory between the two calls simply makes the `rmdir` fail. Any
   * error ends the walk: a tidy tree is a nicety, and never worth failing a
   * delete that already succeeded.
   */
  private async pruneEmptyParents(directory: string): Promise<void> {
    let current = directory;

    while (current !== this.root && current.startsWith(this.root + sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  private async readSidecar(directory: string): Promise<Sidecar> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, SIDECAR_FILE), "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");

      const record = parsed as Record<string, unknown>;
      return {
        contentType:
          typeof record.contentType === "string" ? record.contentType : "application/octet-stream",
        metadata: isStringRecord(record.metadata) ? record.metadata : {},
        ...(typeof record.etag === "string" ? { etag: record.etag } : {}),
      };
    } catch (error) {
      // A body written by something other than this adapter — a seeded fixture,
      // a `docker cp`, a restored backup — has no sidecar, and refusing to read
      // it would be worse than not knowing its content type.
      if (!isNotFound(error)) {
        this.logger.warn(`Unreadable storage sidecar in ${directory}, defaulting content type`);
      }
      return { contentType: "application/octet-stream", metadata: {} };
    }
  }

  private operationError(operation: string, key: string, error: unknown): StorageOperationError {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    return new StorageOperationError(this.name, `${operation} ${key}`, message, code);
  }
}

function etagOf(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

/**
 * The ETag for an object whose sidecar does not carry one — a body put there by
 * something other than this adapter.
 *
 * Size and mtime identify a version well enough for the equality comparison the
 * port promises, and are readable from the inode alone. Hashing the body
 * instead would make `head` cost a full read for every foreign file.
 */
function syntheticEtag(size: number, mtimeMs: number): string {
  return `"${createHash("md5").update(`${size}-${mtimeMs}`).digest("hex")}"`;
}

function isListableKey(key: string): boolean {
  try {
    assertValidObjectKey(key);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * A plain file sits where this key's directory would be, because something
 * outside this adapter put it there. From the caller's flat-keyspace view there
 * is simply no object at that key.
 */
function isNotADirectory(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
