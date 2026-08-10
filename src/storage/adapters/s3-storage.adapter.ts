import { Readable } from "node:stream";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertValidObjectKey, normaliseMetadata } from "../object-key";
import { clampListLimit } from "../list-options";
import {
  ObjectNotFoundError,
  StorageNotConfiguredError,
  StorageOperationError,
} from "../storage.errors";
import type {
  ListObjectsOptions,
  ListObjectsPage,
  PresignedUrl,
  PresigningStorageAdapter,
  PutObjectOptions,
  StorageObject,
  StorageObjectBody,
} from "../ports";

/** Credentials this adapter cannot work without, named in the 503 it raises. */
export const S3_REQUIRED_ENV = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Optional DI token for extra `S3Client` configuration.
 *
 * Everything an operator is likely to want to tune — retry strategy, socket
 * timeouts, a proxy agent — lives on the client rather than in the environment,
 * and there is no sensible way to express a `RequestHandler` as a string. Left
 * unbound in `storage.module.ts`, so a deployment that needs none of it is
 * unaffected.
 *
 * It is also how the contract test reaches this adapter: it binds an in-process
 * `requestHandler`, so the suite exercises the SDK's real request signing,
 * serialisation and XML parsing instead of a stubbed `send`. Using the same
 * extension point production would use keeps the test honest — there is no
 * test-only branch in this file for the fake to take.
 */
export const S3_CLIENT_OPTIONS = Symbol("S3_CLIENT_OPTIONS");

/** The subset of `S3ClientConfig` this adapter lets a caller override. */
export interface S3ClientOptions {
  readonly requestHandler?: S3ClientConfig["requestHandler"];
  readonly maxAttempts?: number;
}

/**
 * Amazon S3, and anything that speaks its API — MinIO, LocalStack, Cloudflare
 * R2, DigitalOcean Spaces. The only adapter that survives more than one replica,
 * and so the only one meant for production.
 *
 * It is also the only one that can presign, which is why it implements
 * {@link PresigningStorageAdapter} and the other two do not: a presigned URL is
 * a signature the *store* verifies, and a disk has nothing to verify it with.
 *
 * Construction never throws. Nest instantiates every adapter eagerly, so a
 * deployment running on disk must be able to boot without S3 credentials; this
 * one reports `isConfigured === false` and refuses each call with a 503 naming
 * the variables to set.
 */
@Injectable()
export class S3StorageAdapter implements PresigningStorageAdapter {
  readonly name = "s3" as const;

  private readonly client: S3Client | null;
  private readonly bucket: string | null;

  constructor(
    config: ConfigService,
    @Optional() @Inject(S3_CLIENT_OPTIONS) clientOptions?: S3ClientOptions,
  ) {
    const bucket = config.get<string>("S3_BUCKET");
    const accessKeyId = config.get<string>("S3_ACCESS_KEY_ID");
    const secretAccessKey = config.get<string>("S3_SECRET_ACCESS_KEY");

    if (!bucket || !accessKeyId || !secretAccessKey) {
      this.client = null;
      this.bucket = null;
      return;
    }

    const endpoint = config.get<string>("S3_ENDPOINT");
    // A custom endpoint is always an S3-compatible store rather than AWS, and
    // those are effectively all path-style: virtual-host addressing would need
    // a wildcard DNS entry per bucket, which no one running MinIO in
    // docker-compose has.
    this.bucket = bucket;
    this.client = new S3Client({
      region: config.get<string>("S3_REGION") ?? "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      // Last, so an explicit override wins over the defaults above.
      ...(clientOptions ?? {}),
    });
  }

  get isConfigured(): boolean {
    return this.client !== null && this.bucket !== null;
  }

  async put(key: string, body: Buffer, options: PutObjectOptions): Promise<StorageObject> {
    assertValidObjectKey(key);
    const metadata = normaliseMetadata(options.metadata);
    const { client, bucket } = this.require();

    const result = await this.call("put", key, () =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          Metadata: metadata,
          ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        }),
      ),
    );

    // Built from what we sent rather than from a follow-up `head`: S3 is
    // read-after-write consistent for new objects, but a second round trip on
    // every upload to learn a size we already know is a waste.
    return {
      key,
      size: body.byteLength,
      contentType: options.contentType,
      etag: result.ETag ?? "",
      lastModified: new Date(),
      metadata,
    };
  }

  async get(key: string): Promise<StorageObjectBody> {
    assertValidObjectKey(key);
    const { client, bucket } = this.require();

    const result = await this.call("get", key, () =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    );

    // `transformToByteArray` drains and closes the response stream. Skipping it
    // for a body we are about to read anyway would leak the socket back into
    // the pool unread, where it blocks until the request times out.
    const bytes = await (result.Body?.transformToByteArray() ?? Promise.resolve(new Uint8Array()));

    return {
      ...describeObject(key, result),
      size: result.ContentLength ?? bytes.byteLength,
      body: Buffer.from(bytes),
    };
  }

  async getStream(key: string): Promise<{ object: StorageObject; body: Readable }> {
    assertValidObjectKey(key);
    const { client, bucket } = this.require();

    const result = await this.call("getStream", key, () =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    );

    const body = result.Body;
    if (!(body instanceof Readable)) {
      // On Node the SDK always hands back a `Readable`; in a browser build it
      // would be a web stream. Failing loudly beats returning something the
      // caller will `pipe()` into a crash.
      throw new StorageOperationError(
        this.name,
        `getStream ${key}`,
        "S3 returned a body that is not a Node readable stream",
      );
    }

    return { object: describeObject(key, result), body };
  }

  async head(key: string): Promise<StorageObject> {
    assertValidObjectKey(key);
    const { client, bucket } = this.require();

    const result = await this.call("head", key, () =>
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    );

    return describeObject(key, result);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.head(key);
      return true;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidObjectKey(key);
    const { client, bucket } = this.require();

    // S3's DeleteObject succeeds for a key that was never there, which is the
    // idempotence the port promises — nothing to special-case.
    await this.call("delete", key, () =>
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    );
  }

  async list(options: ListObjectsOptions = {}): Promise<ListObjectsPage> {
    const { client, bucket } = this.require();
    const limit = clampListLimit(options.limit);

    const result = await this.call("list", options.prefix ?? "", () =>
      client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: limit,
          ...(options.prefix ? { Prefix: options.prefix } : {}),
          ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
        }),
      ),
    );

    const objects: StorageObject[] = (result.Contents ?? [])
      .filter((entry): entry is typeof entry & { Key: string } => typeof entry.Key === "string")
      .map((entry) => ({
        key: entry.Key,
        size: entry.Size ?? 0,
        // `ListObjectsV2` does not return content type or user metadata — that
        // is a `HeadObject` per key, and doing 1000 of them behind one `list`
        // call would be a hidden fan-out. Callers that need either should
        // `head` the keys they care about.
        contentType: DEFAULT_CONTENT_TYPE,
        etag: entry.ETag ?? "",
        lastModified: entry.LastModified ?? new Date(0),
        metadata: {},
      }));

    return {
      objects,
      // S3 sets `IsTruncated` and only then a continuation token. Trusting the
      // token's presence alone would page forever against a store that returns
      // a stale one.
      nextCursor: result.IsTruncated ? (result.NextContinuationToken ?? null) : null,
    };
  }

  async presignPut(
    key: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<PresignedUrl> {
    assertValidObjectKey(key);
    const { client, bucket } = this.require();

    const url = await this.call("presignPut", key, () =>
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        {
          expiresIn: expiresInSeconds,
          // Without this the presigner signs `host` alone, and `ContentType`
          // becomes a suggestion: a client handed a URL for `image/jpeg` could
          // upload `text/html` to the same key, and the bucket would then serve
          // attacker-controlled HTML from its own origin. Signing the header
          // makes S3 reject the mismatch, rather than us discovering it after
          // the object has landed.
          signableHeaders: new Set(["content-type"]),
        },
      ),
    );

    return { url, key, method: "PUT", expiresAt: expiryFrom(expiresInSeconds) };
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<PresignedUrl> {
    assertValidObjectKey(key);
    const { client, bucket } = this.require();

    const url = await this.call("presignGet", key, () =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      }),
    );

    return { url, key, method: "GET", expiresAt: expiryFrom(expiresInSeconds) };
  }

  private require(): { client: S3Client; bucket: string } {
    if (!this.client || !this.bucket) {
      throw new StorageNotConfiguredError(this.name, S3_REQUIRED_ENV);
    }
    return { client: this.client, bucket: this.bucket };
  }

  /**
   * Runs an SDK call and translates its failures into this module's errors.
   *
   * Centralised because the mapping is not obvious and getting it wrong in one
   * method would make that method the odd one out: S3 raises `NoSuchKey` for a
   * missing object on `GetObject` but a bare `NotFound` on `HeadObject`, and
   * S3-compatible stores are inconsistent enough that the raw HTTP status is
   * the only reliable signal for both.
   */
  private async call<T>(operation: string, key: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isMissingObject(error)) {
        throw new ObjectNotFoundError(key);
      }
      if (error instanceof S3ServiceException) {
        throw new StorageOperationError(
          this.name,
          `${operation} ${key}`,
          error.message,
          error.name,
        );
      }
      throw new StorageOperationError(
        this.name,
        `${operation} ${key}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function isMissingObject(error: unknown): boolean {
  if (error instanceof NoSuchKey || error instanceof NotFound) return true;
  // MinIO and R2 do not always deserialise into the SDK's typed exceptions, so
  // the status is the fallback. `NoSuchBucket` is deliberately excluded: a
  // missing bucket is an operator problem and must not read as an empty one.
  return (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404 &&
    error.name !== "NoSuchBucket"
  );
}

/** Shared shape for the GET and HEAD outputs, which differ only in the body. */
function describeObject(
  key: string,
  result: {
    ContentLength?: number;
    ContentType?: string;
    ETag?: string;
    LastModified?: Date;
    Metadata?: Record<string, string>;
  },
): StorageObject {
  return {
    key,
    size: result.ContentLength ?? 0,
    contentType: result.ContentType ?? DEFAULT_CONTENT_TYPE,
    etag: result.ETag ?? "",
    lastModified: result.LastModified ?? new Date(0),
    // S3 lower-cases metadata keys in transit, which is why `normaliseMetadata`
    // lower-cases them on the way in: the round trip is then faithful here and
    // identical against the other two adapters.
    metadata: result.Metadata ?? {},
  };
}

function expiryFrom(expiresInSeconds: number): Date {
  return new Date(Date.now() + expiresInSeconds * 1000);
}
