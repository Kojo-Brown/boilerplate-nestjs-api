import type { Readable } from "node:stream";

/**
 * Every adapter the storage module can be pointed at.
 *
 * Declared here rather than in `config/env.schema.ts` so the domain owns its
 * own vocabulary and the config layer imports it, not the other way round —
 * the same arrangement `PAYMENT_PROVIDER_NAMES` and `NOTIFICATION_CHANNEL_NAMES`
 * use. Adding a backend is then a change in `src/storage` that the env schema
 * picks up as a type error rather than silently ignores.
 */
export const STORAGE_ADAPTER_NAMES = ["s3", "local", "memory"] as const;

export type StorageAdapterName = (typeof STORAGE_ADAPTER_NAMES)[number];

export function isStorageAdapterName(value: string): value is StorageAdapterName {
  return (STORAGE_ADAPTER_NAMES as readonly string[]).includes(value);
}

/**
 * What every backend can say about a stored object without reading its bytes.
 *
 * Deliberately smaller than S3's `HeadObjectOutput`: storage class, versioning,
 * server-side encryption and object lock have no counterpart on a filesystem or
 * in a `Map`, so exposing them would make the adapters non-substitutable the
 * first time a caller branched on one.
 */
export interface StorageObject {
  readonly key: string;
  /** Size in bytes of the stored body. */
  readonly size: number;
  readonly contentType: string;
  /**
   * Opaque change token. S3 returns one; the other two synthesise a content
   * hash. Only ever compared for equality — never parsed, and never assumed to
   * be an MD5, because S3's own multipart ETags are not one either.
   */
  readonly etag: string;
  readonly lastModified: Date;
  /** Caller-supplied metadata round-tripped verbatim. Keys are lower-cased. */
  readonly metadata: Readonly<Record<string, string>>;
}

/** A stored object together with its bytes. */
export interface StorageObjectBody extends StorageObject {
  readonly body: Buffer;
}

export interface PutObjectOptions {
  readonly contentType: string;
  /**
   * Small, non-secret annotations stored alongside the object — an uploader id,
   * an original filename. S3 caps user metadata at 2 KB of headers and rejects
   * non-ASCII, so the adapters validate against that lowest common denominator
   * rather than letting a value that works locally fail in production.
   */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Passed through to `Cache-Control`. Ignored by backends that serve nothing. */
  readonly cacheControl?: string;
}

export interface ListObjectsOptions {
  /** Restricts the listing to keys starting with this string. */
  readonly prefix?: string;
  /** Maximum keys in one page. Adapters clamp to {@link LIST_OBJECTS_MAX_LIMIT}. */
  readonly limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

/**
 * S3 caps `ListObjectsV2` at 1000 keys per request and the other two adapters
 * follow it, so a caller that pages against one backend pages identically
 * against the others.
 */
export const LIST_OBJECTS_MAX_LIMIT = 1000;

export interface ListObjectsPage {
  readonly objects: readonly StorageObject[];
  /**
   * Cursor for the next page, or `null` when this is the last one.
   *
   * `null` rather than `undefined` because callers loop on `while (cursor)`,
   * and an adapter that returned `undefined` from one backend and `null` from
   * another would still work — right up until someone wrote `cursor !== null`.
   */
  readonly nextCursor: string | null;
}

/**
 * An object store, as the rest of the application sees one — the Adapter of the
 * pattern.
 *
 * Every backend is interchangeable behind these members, which is what lets
 * `StorageService` hold one without naming it. Nothing outside this module
 * references `S3StorageAdapter`: swapping S3 for a disk in a single-node
 * deployment, or for a `Map` in a test, is one environment variable and no code
 * change (DIP + OCP).
 *
 * The interface is written to S3's semantics rather than a filesystem's,
 * because that is the direction the mismatch is survivable in: a flat keyspace
 * with atomic whole-object writes can be emulated on a disk, but directory
 * handles, partial writes and rename semantics cannot be emulated on S3.
 */
export interface StorageAdapter {
  readonly name: StorageAdapterName;

  /**
   * Whether the credentials and resources this adapter needs are present.
   *
   * Nest instantiates every adapter eagerly, so an unconfigured S3 must
   * construct cleanly and refuse work later — the same shape the payment
   * providers and notification channels use. `StorageService` checks this at
   * boot for the *selected* adapter only, so a deployment running on disk does
   * not need S3 credentials to start.
   */
  readonly isConfigured: boolean;

  /**
   * Stores `body` at `key`, replacing whatever was there.
   *
   * Overwrite is unconditional and last-writer-wins on all three backends,
   * matching S3: there is no compare-and-swap here because S3 had none for the
   * decade this interface has to keep working across. A caller needing
   * conditional writes wants the optimistic-concurrency item in Phase 9, not a
   * flag on this method.
   */
  put(key: string, body: Buffer, options: PutObjectOptions): Promise<StorageObject>;

  /**
   * Reads the whole object into memory.
   *
   * Throws {@link ObjectNotFoundError} if the key is absent — never resolves
   * with an empty buffer, which would be indistinguishable from a zero-byte
   * object that really exists.
   */
  get(key: string): Promise<StorageObjectBody>;

  /**
   * Opens the object as a stream, for bodies too large to hold in memory.
   *
   * Separate from `get()` because the caller has to own the stream's lifetime:
   * an abandoned S3 response socket stays checked out of the connection pool
   * until it times out. Consumers that just need the bytes should use `get()`.
   */
  getStream(key: string): Promise<{ readonly object: StorageObject; readonly body: Readable }>;

  /** Metadata only, no bytes. Throws {@link ObjectNotFoundError} if absent. */
  head(key: string): Promise<StorageObject>;

  /** Whether the key exists. Never throws for a missing key. */
  exists(key: string): Promise<boolean>;

  /**
   * Removes the object.
   *
   * Idempotent: deleting a key that is already gone resolves rather than
   * throwing, because S3's `DeleteObject` does and a caller retrying a failed
   * delete must not have to distinguish the two.
   */
  delete(key: string): Promise<void>;

  /**
   * One page of keys, in lexicographic order.
   *
   * Ordering is guaranteed because S3 guarantees it and the other two sort to
   * match; a caller that paginates depends on it, since the cursor is a
   * position in that order.
   */
  list(options?: ListObjectsOptions): Promise<ListObjectsPage>;
}

/**
 * The subset of backends that can hand a client a URL to upload or download
 * with directly.
 *
 * Split out rather than folded into {@link StorageAdapter} because presigning
 * is not something a disk or a `Map` can do, and pretending otherwise is the
 * usual way an adapter interface rots: either every backend grows a method that
 * throws — so callers cannot rely on it and the interface has stopped meaning
 * anything (ISP) — or the local ones fabricate a URL nothing serves.
 *
 * The honest shape is a capability a caller tests for. `StorageService.presign*`
 * throws {@link PresignedUrlsUnsupportedError} (501) when the active adapter
 * lacks it, which is a truthful answer a client can act on: upload through the
 * API instead.
 *
 * The alternative — having the local adapters issue HMAC-signed URLs back to
 * our own API — is a real design and a reasonable follow-up, but it is a signed
 * public upload endpoint, not an adapter method, so it is out of scope here.
 * See `docs/storage.md`.
 */
export interface PresigningStorageAdapter extends StorageAdapter {
  /**
   * A URL the client may `PUT` the given content type to.
   *
   * `contentType` is bound into the signature, so a client that uploads
   * something else is rejected by the store rather than by us after the fact.
   */
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<PresignedUrl>;

  /** A URL the client may `GET` the object from. */
  presignGet(key: string, expiresInSeconds: number): Promise<PresignedUrl>;
}

export interface PresignedUrl {
  readonly url: string;
  readonly key: string;
  readonly method: "PUT" | "GET";
  readonly expiresAt: Date;
}

/**
 * Whether this adapter can issue presigned URLs.
 *
 * A type guard rather than a boolean flag on the port, so a caller that checks
 * it also gets the two methods typed — the whole point of splitting the
 * interface.
 */
export function supportsPresigning(adapter: StorageAdapter): adapter is PresigningStorageAdapter {
  const candidate = adapter as Partial<PresigningStorageAdapter>;
  return typeof candidate.presignPut === "function" && typeof candidate.presignGet === "function";
}

/**
 * DI token for the array of every registered {@link StorageAdapter}.
 *
 * `StorageService` injects the collection and selects from it by name, so it
 * holds no reference to any implementation and adding a backend touches only
 * `storage.module.ts`.
 */
export const STORAGE_ADAPTERS = Symbol("STORAGE_ADAPTERS");
