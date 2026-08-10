import { InvalidObjectKeyError, InvalidObjectMetadataError } from "./storage.errors";

/**
 * S3's own limit: 1024 bytes of UTF-8, not 1024 characters. Enforced in bytes
 * so a key of emoji does not pass here and fail against the real bucket.
 */
export const MAX_KEY_BYTES = 1024;

/**
 * Per-segment limit, from the filesystem rather than from S3.
 *
 * S3 would happily take a single 1024-byte key with no slashes in it; every
 * mainstream filesystem caps one path component at 255 bytes and answers
 * `ENAMETOOLONG`. Applying the stricter of the two limits everywhere is the
 * whole point of validating centrally: a key that works against the in-memory
 * adapter in a test has to work against the disk in docker-compose and against
 * the bucket in production, and the alternative is a 502 that only appears on
 * one deployment.
 */
export const MAX_KEY_SEGMENT_BYTES = 255;

/**
 * S3 caps *all* user metadata at 2 KB of header, counting keys and values
 * together. Applied to every adapter so a write that succeeds against the
 * in-memory adapter in a test cannot fail against the bucket in production.
 */
export const MAX_METADATA_BYTES = 2048;

/**
 * The one place a storage key is decided to be safe.
 *
 * The same string has to be usable as an S3 key *and* as a path under the local
 * root, and those two have very different ideas about what is dangerous. `../`
 * is an ordinary character sequence in a flat keyspace and a directory escape
 * on a disk; a NUL byte truncates a C path and is merely illegal in S3. Rather
 * than let each adapter defend itself — and let the in-memory one, which is
 * safe from all of it, quietly accept keys the others would not — validation
 * happens once at the boundary. That is what makes a key exercised in a test
 * against the `Map` proof of anything about production.
 *
 * The local adapter still re-checks the resolved path against its root. Two
 * independent checks is deliberate: this one is a parser, and a parser that is
 * wrong about one encoding should not be the only thing between a request and
 * `/etc/passwd`.
 */
export function assertValidObjectKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidObjectKeyError(String(key), "key must be a non-empty string");
  }

  const byteLength = Buffer.byteLength(key, "utf8");
  if (byteLength > MAX_KEY_BYTES) {
    throw new InvalidObjectKeyError(
      key,
      `key is ${byteLength} bytes, over the ${MAX_KEY_BYTES}-byte limit`,
    );
  }

  // Control characters, including NUL. S3 rejects them and a filesystem
  // truncates at the first NUL, so "a\0/../../etc/passwd" would be written to a
  // path this function had approved as "a".
  // eslint-disable-next-line no-control-regex -- rejecting control bytes is the point
  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new InvalidObjectKeyError(key, "key contains control characters");
  }

  // Unicode escapes matter here: a backslash is a path separator on Windows and
  // an ordinary character in S3, so allowing it makes the same key mean two
  // different things depending on where the API happens to be running.
  if (key.includes("\\")) {
    throw new InvalidObjectKeyError(key, "key must not contain a backslash");
  }

  if (key.startsWith("/")) {
    throw new InvalidObjectKeyError(key, "key must be relative, not start with '/'");
  }

  if (key.endsWith("/")) {
    // A trailing slash is S3's directory-placeholder convention. Storing an
    // object there is legal but produces a key no `get` can meaningfully
    // return, and on a disk it is a request to write a file named "".
    throw new InvalidObjectKeyError(key, "key must not end with '/'");
  }

  const segments = key.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new InvalidObjectKeyError(key, "key must not contain an empty path segment");
    }
    if (segment === "." || segment === "..") {
      throw new InvalidObjectKeyError(key, "key must not contain '.' or '..' segments");
    }
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (segmentBytes > MAX_KEY_SEGMENT_BYTES) {
      throw new InvalidObjectKeyError(
        key,
        `key segment is ${segmentBytes} bytes, over the ${MAX_KEY_SEGMENT_BYTES}-byte limit ` +
          `a filesystem allows for one path component`,
      );
    }
    if (segment !== segment.trim()) {
      // Leading and trailing spaces are legal in S3 and near-impossible to see
      // in a log or a console, which makes "photo.jpg " and "photo.jpg" an
      // excellent source of unreproducible bug reports.
      throw new InvalidObjectKeyError(key, "key segments must not have leading or trailing spaces");
    }
  }

  // A Windows drive-relative prefix ("C:file") resolves against that drive's
  // current directory rather than the root we joined it to. Cheap to reject and
  // impossible to reason about otherwise.
  if (/^[a-zA-Z]:/.test(key)) {
    throw new InvalidObjectKeyError(key, "key must not start with a drive letter");
  }

  return key;
}

/**
 * Normalises and checks caller-supplied metadata against S3's constraints.
 *
 * Keys are lower-cased because S3 returns them that way — a caller who wrote
 * `uploadedBy` and read back `uploadedby` would otherwise find the round trip
 * lossy against one backend and faithful against the other two. Values must be
 * ASCII for the same reason: they travel as HTTP headers, and S3 does not
 * decode RFC 2047 or percent-encoding on the way out.
 */
export function normaliseMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!metadata) return {};

  const normalised: Record<string, string> = {};
  let bytes = 0;

  for (const [rawKey, value] of Object.entries(metadata)) {
    const key = rawKey.toLowerCase();

    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      throw new InvalidObjectMetadataError(
        `key "${rawKey}" must be alphanumeric with hyphens, as it becomes an HTTP header name`,
      );
    }
    if (Object.hasOwn(normalised, key)) {
      // Two keys differing only in case would collide silently once lower-cased,
      // and which one survived would depend on property order.
      throw new InvalidObjectMetadataError(`duplicate key "${key}" after case normalisation`);
    }
    if (typeof value !== "string") {
      throw new InvalidObjectMetadataError(`value for "${key}" must be a string`);
    }
    // Anything outside printable ASCII, which covers control bytes and every
    // non-Latin character. Deliberately narrow: this is an HTTP header value.
    if (/[^ -~]/.test(value)) {
      throw new InvalidObjectMetadataError(
        `value for "${key}" must be printable ASCII, as it travels as an HTTP header`,
      );
    }

    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    normalised[key] = value;
  }

  if (bytes > MAX_METADATA_BYTES) {
    throw new InvalidObjectMetadataError(
      `metadata is ${bytes} bytes, over the ${MAX_METADATA_BYTES}-byte limit`,
    );
  }

  return normalised;
}
