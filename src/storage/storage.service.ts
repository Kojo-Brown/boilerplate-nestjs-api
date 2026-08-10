import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { STORAGE_ADAPTERS, isStorageAdapterName, supportsPresigning } from "./ports";
import { PresignedUrlsUnsupportedError, StorageNotConfiguredError } from "./storage.errors";
import { S3_REQUIRED_ENV } from "./adapters/s3-storage.adapter";
import type { Readable } from "node:stream";
import type {
  ListObjectsOptions,
  ListObjectsPage,
  PresignedUrl,
  PutObjectOptions,
  StorageAdapter,
  StorageAdapterName,
  StorageObject,
  StorageObjectBody,
} from "./ports";

/** Kept for the presign endpoints' response shape, which predates the port. */
export interface PresignedUrlResult {
  url: string;
  key: string;
  expiresAt: Date;
}

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 3600;

/**
 * The application's one way to store a file.
 *
 * Holds the adapter selected by `STORAGE_ADAPTER` and forwards to it. Nothing
 * else in `src` imports an adapter class, so switching a deployment from S3 to a
 * disk is one environment variable (DIP), and adding a fourth backend touches
 * only `storage.module.ts` (OCP).
 *
 * The selection happens once, at construction, and every way it can be wrong is
 * a boot failure rather than a 500 on the first upload: an unknown name, a name
 * with no registered adapter, a selected adapter with no credentials. The
 * project already takes this position for `PAYMENTS_PROVIDER`, and the argument
 * is the same — a deployment that cannot store files should fail to start, not
 * fail quietly under load an hour later.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly adapter: StorageAdapter;

  constructor(
    config: ConfigService,
    @Inject(STORAGE_ADAPTERS) adapters: readonly StorageAdapter[],
  ) {
    const registry = new Map<StorageAdapterName, StorageAdapter>();
    for (const adapter of adapters) {
      if (registry.has(adapter.name)) {
        // Two adapters on one name means one silently shadows the other, and
        // which one wins depends on module registration order.
        throw new Error(`Duplicate storage adapter registered for name "${adapter.name}"`);
      }
      registry.set(adapter.name, adapter);
    }

    const configured = config.get<string>("STORAGE_ADAPTER") ?? "memory";
    if (!isStorageAdapterName(configured) || !registry.has(configured)) {
      throw new Error(
        `STORAGE_ADAPTER is "${configured}", which is not a registered adapter ` +
          `(${[...registry.keys()].join(", ")})`,
      );
    }

    const selected = registry.get(configured);
    if (!selected) throw new Error(`No storage adapter registered for "${configured}"`);
    if (!selected.isConfigured) {
      // The env schema catches this for a normal boot; this covers a module
      // constructed directly in a test or a script that bypasses validation.
      throw new StorageNotConfiguredError(selected.name, requiredEnvFor(selected.name));
    }

    this.adapter = selected;

    if (config.get<string>("NODE_ENV") === "production" && selected.name === "local") {
      // Not fatal — a single-node deployment on a mounted volume is a legitimate
      // production setup — but it is a silent 404 the moment a second replica
      // starts, so it should never be a surprise found in an incident.
      this.logger.warn(
        "Storage is running on the local disk in production. Objects are not shared " +
          "between replicas: a file written by one instance is a 404 from another.",
      );
    }
  }

  /** The backend in use, for health checks and diagnostics. */
  get adapterName(): StorageAdapterName {
    return this.adapter.name;
  }

  /** Whether presigned URLs are available on this deployment. */
  get supportsPresignedUrls(): boolean {
    return supportsPresigning(this.adapter);
  }

  put(key: string, body: Buffer, options: PutObjectOptions): Promise<StorageObject> {
    return this.adapter.put(key, body, options);
  }

  get(key: string): Promise<StorageObjectBody> {
    return this.adapter.get(key);
  }

  getStream(key: string): Promise<{ object: StorageObject; body: Readable }> {
    return this.adapter.getStream(key);
  }

  head(key: string): Promise<StorageObject> {
    return this.adapter.head(key);
  }

  exists(key: string): Promise<boolean> {
    return this.adapter.exists(key);
  }

  delete(key: string): Promise<void> {
    return this.adapter.delete(key);
  }

  list(options?: ListObjectsOptions): Promise<ListObjectsPage> {
    return this.adapter.list(options);
  }

  /**
   * Stores a buffer and returns its key.
   *
   * Predates the port and is kept because `UsersController` uploads avatars
   * through it. It is a thin call onto `put`, so the two cannot drift.
   */
  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const stored = await this.put(key, buffer, { contentType });
    return stored.key;
  }

  async getPresignedPutUrl(
    key: string,
    contentType: string,
    expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS,
  ): Promise<PresignedUrlResult> {
    const url = await this.requirePresigning().presignPut(key, contentType, expiresIn);
    return toResult(url);
  }

  async getPresignedGetUrl(
    key: string,
    expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS,
  ): Promise<PresignedUrlResult> {
    const url = await this.requirePresigning().presignGet(key, expiresIn);
    return toResult(url);
  }

  /**
   * The active adapter, if it can presign.
   *
   * A 501 rather than a 503, because no configuration will make a filesystem
   * verify a signature — the client's remedy is to upload through the API, and
   * a 503 would invite a retry that can never succeed. See `docs/storage.md`.
   */
  private requirePresigning() {
    if (!supportsPresigning(this.adapter)) {
      throw new PresignedUrlsUnsupportedError(this.adapter.name);
    }
    return this.adapter;
  }
}

function toResult(url: PresignedUrl): PresignedUrlResult {
  return { url: url.url, key: url.key, expiresAt: url.expiresAt };
}

/**
 * Credentials each adapter needs, for the error message only.
 *
 * Kept here rather than on the port so `StorageAdapter` stays a behavioural
 * interface: an implementation should not have to describe its own environment
 * variables to satisfy the type. Mirrors `requiredEnvFor` in
 * `payment-provider.factory.ts`.
 */
function requiredEnvFor(name: StorageAdapterName): readonly string[] {
  switch (name) {
    case "s3":
      return S3_REQUIRED_ENV;
    case "local":
      return ["STORAGE_LOCAL_ROOT"];
    case "memory":
      return [];
  }
}
