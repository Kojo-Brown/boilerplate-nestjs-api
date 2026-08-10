import {
  BadGatewayException,
  BadRequestException,
  HttpStatus,
  NotFoundException,
  NotImplementedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { StorageAdapterName } from "./ports";

/**
 * Storage failures are `HttpException`s so `AllExceptionsFilter` renders them
 * with the right status when one reaches a request handler — the same
 * arrangement `payment.errors.ts` and `notification.errors.ts` use. The status
 * on each is the one the *caller* deserves, which is not always the one the
 * backend reported: a missing bucket is a 503 because it is an operator
 * problem, while a traversing key is a 400 because whoever sent it is at fault.
 */

/**
 * The key does not exist.
 *
 * A 404 rather than a 500 because "no such object" is a normal answer, and the
 * three adapters have to agree on it: S3 raises `NoSuchKey` on GET but a bare
 * `NotFound` on HEAD, a filesystem raises `ENOENT`, and a `Map` returns
 * `undefined`. Normalising here is what lets a caller catch one type.
 */
export class ObjectNotFoundError extends NotFoundException {
  constructor(readonly key: string) {
    super(`No stored object with key "${key}"`);
  }
}

/**
 * The key is not one this module will accept.
 *
 * Rejected before it reaches any backend, because the same string has to be
 * safe as an S3 key *and* as a path segment under the local root — `../` is
 * inert in a flat keyspace and a directory escape on a disk. Validating once,
 * at the edge, is what keeps the adapters substitutable: a key that works in
 * the in-memory adapter during a test cannot become a traversal in production.
 */
export class InvalidObjectKeyError extends BadRequestException {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`Invalid storage key: ${reason}`);
  }
}

/** Caller-supplied metadata that S3 would reject, caught before the write. */
export class InvalidObjectMetadataError extends BadRequestException {
  constructor(readonly reason: string) {
    super(`Invalid storage metadata: ${reason}`);
  }
}

/**
 * The selected adapter exists but has nothing to work with.
 *
 * 503, not 500: the code is fine and the request was fine, the deployment is
 * missing a variable. Naming the variables is the difference between this being
 * a one-minute fix and a debugging session.
 */
export class StorageNotConfiguredError extends ServiceUnavailableException {
  constructor(
    readonly adapter: StorageAdapterName,
    readonly requiredEnv: readonly string[],
  ) {
    super(
      requiredEnv.length > 0
        ? `Storage adapter "${adapter}" is not configured. Set ${requiredEnv.join(", ")}.`
        : `Storage adapter "${adapter}" is not configured.`,
    );
  }
}

/**
 * The active adapter cannot issue presigned URLs.
 *
 * 501 rather than 503, because no configuration will enable it — a filesystem
 * has no signing endpoint. The client's remedy is to upload through the API,
 * and a status that says "not implemented here" points at that, where a 503
 * would invite a retry that can never succeed.
 */
export class PresignedUrlsUnsupportedError extends NotImplementedException {
  constructor(readonly adapter: StorageAdapterName) {
    super(
      `Storage adapter "${adapter}" cannot issue presigned URLs. ` +
        `Upload through the API instead, or run with STORAGE_ADAPTER=s3.`,
    );
  }
}

/**
 * The backend refused or failed an operation.
 *
 * 502 by default: we are the client of something that broke, and the caller did
 * nothing wrong. Carries the backend's own code so a log line can be traced
 * back to an S3 `AccessDenied` or an `EACCES` without re-reading the stack.
 */
export class StorageOperationError extends BadGatewayException {
  constructor(
    readonly adapter: StorageAdapterName,
    readonly operation: string,
    message: string,
    readonly upstreamCode?: string,
  ) {
    super(`storage/${adapter} ${operation} failed: ${message}`);
  }
}

/** Status carried by {@link StorageOperationError}, for tests and docs. */
export const STORAGE_OPERATION_ERROR_STATUS = HttpStatus.BAD_GATEWAY;
