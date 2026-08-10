import { LIST_OBJECTS_MAX_LIMIT } from "./ports";

/**
 * Normalises a caller's page size for every adapter.
 *
 * Out-of-range values are clamped rather than rejected because S3 clamps
 * `MaxKeys` rather than erroring, and a caller who asked for 5000 keys, got a
 * page from the bucket and a `BadRequest` from the disk would have found the
 * adapters non-substitutable over something no one would think to test.
 */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined) return LIST_OBJECTS_MAX_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.floor(limit), LIST_OBJECTS_MAX_LIMIT);
}
