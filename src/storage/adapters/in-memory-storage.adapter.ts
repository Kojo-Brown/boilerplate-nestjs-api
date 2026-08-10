import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import { assertValidObjectKey, normaliseMetadata } from "../object-key";
import { ObjectNotFoundError } from "../storage.errors";
import { clampListLimit } from "../list-options";
import type {
  ListObjectsOptions,
  ListObjectsPage,
  PutObjectOptions,
  StorageAdapter,
  StorageObject,
  StorageObjectBody,
} from "../ports";

interface StoredEntry {
  readonly body: Buffer;
  readonly object: StorageObject;
}

/**
 * An object store in a `Map`.
 *
 * Exists for two jobs, and is honest about both. In a test it removes the
 * network and the disk from anything that stores a file, so a suite that
 * exercises avatar upload does not need a bucket, credentials, or a temporary
 * directory to clean up. In `NODE_ENV=development` it lets the API boot with no
 * storage configuration at all.
 *
 * It is refused at boot in production by `env.schema.ts`, and that refusal is
 * the point of writing it: the failure mode of a memory-backed store is not an
 * error anyone sees, it is uploads that quietly vanish on the next deploy. A
 * default that is safe in a test and catastrophic in production has to be
 * unable to reach production, not merely discouraged in a comment.
 *
 * Bodies are copied on the way in and on the way out. Handing back the caller's
 * own `Buffer` would make this adapter the only one where mutating what you
 * uploaded changes what is stored — exactly the kind of difference that lets a
 * test pass against a `Map` and fail against S3.
 */
@Injectable()
export class InMemoryStorageAdapter implements StorageAdapter {
  readonly name = "memory" as const;

  /** Nothing to configure, so nothing can be missing. */
  readonly isConfigured = true;

  private readonly objects = new Map<string, StoredEntry>();

  async put(key: string, body: Buffer, options: PutObjectOptions): Promise<StorageObject> {
    assertValidObjectKey(key);
    const metadata = normaliseMetadata(options.metadata);
    const stored = Buffer.from(body);

    const object: StorageObject = {
      key,
      size: stored.byteLength,
      contentType: options.contentType,
      etag: `"${createHash("md5").update(stored).digest("hex")}"`,
      lastModified: new Date(),
      metadata,
    };

    this.objects.set(key, { body: stored, object });
    return object;
  }

  async get(key: string): Promise<StorageObjectBody> {
    const entry = this.require(key);
    return { ...entry.object, body: Buffer.from(entry.body) };
  }

  async getStream(key: string): Promise<{ object: StorageObject; body: Readable }> {
    const entry = this.require(key);
    return { object: entry.object, body: Readable.from([Buffer.from(entry.body)]) };
  }

  async head(key: string): Promise<StorageObject> {
    return this.require(key).object;
  }

  async exists(key: string): Promise<boolean> {
    assertValidObjectKey(key);
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    assertValidObjectKey(key);
    // Idempotent, like S3's DeleteObject: `Map.delete` returning false is not
    // an error the caller can do anything about.
    this.objects.delete(key);
  }

  async list(options: ListObjectsOptions = {}): Promise<ListObjectsPage> {
    const limit = clampListLimit(options.limit);
    const prefix = options.prefix ?? "";

    // Sorted every call rather than kept sorted, because `list` is a test and
    // development affordance and the keyspace is small by construction. Sorting
    // is not optional though: the cursor is a position in this order, so an
    // insertion-ordered `Map` would silently skip or repeat keys across pages.
    const matching = [...this.objects.values()]
      .map((entry) => entry.object)
      .filter(
        (object) =>
          object.key.startsWith(prefix) &&
          (options.cursor === undefined || object.key > options.cursor),
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const objects = matching.slice(0, limit);
    const last = objects.at(-1);

    return { objects, nextCursor: matching.length > limit && last ? last.key : null };
  }

  /** Drops every object. For test teardown; nothing in `src` outside tests calls it. */
  clear(): void {
    this.objects.clear();
  }

  private require(key: string): StoredEntry {
    assertValidObjectKey(key);
    const entry = this.objects.get(key);
    if (!entry) throw new ObjectNotFoundError(key);
    return entry;
  }
}
