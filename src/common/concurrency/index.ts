export {
  ETAG_HEADER,
  IF_MATCH_HEADER,
  UNCONDITIONAL,
  describeMismatch,
  formatEntityTag,
  isSatisfiedBy,
  parseIfMatch,
} from "./entity-tag";
export type { ExpectedVersion, ParsedEntityTag } from "./entity-tag";

export { VERSIONED_RESOURCE_MARKER, isVersionedResource, versioned } from "./versioned-resource";
export type { VersionedResource } from "./versioned-resource";

export { IfMatch, requireConditional } from "./if-match.decorator";

export { EntityTagInterceptor } from "./entity-tag.interceptor";

export { PreconditionRequiredException, VersionConflictError } from "./concurrency.exceptions";

export { ApiConditionalWrite, ApiEntityTag } from "./concurrency.openapi";
