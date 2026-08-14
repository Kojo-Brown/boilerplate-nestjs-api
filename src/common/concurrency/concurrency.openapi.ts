import { applyDecorators } from "@nestjs/common";
import { ApiHeader, ApiPreconditionFailedResponse, ApiResponse } from "@nestjs/swagger";

const IF_MATCH_DESCRIPTION = [
  "The `ETag` of the version you read, echoed back so the write applies only if",
  "nothing has changed since. `*` accepts any current version and asserts only that",
  "the resource still exists.",
].join(" ");

const PRECONDITION_FAILED_DESCRIPTION =
  "The resource has changed since the version named in `If-Match`. Re-read it, re-apply your change, and retry with the new `ETag`.";

const PRECONDITION_REQUIRED_DESCRIPTION =
  "`If-Match` is required on this endpoint and was not sent.";

/**
 * Documents a route that emits an `ETag`.
 *
 * Applied by hand per route rather than swept over the whole document the way
 * `documentIdempotency` is, because — unlike idempotency — nothing about a
 * route's method or path says whether it is versioned. Only the handler knows,
 * and a document-wide rule would have to guess.
 */
export function ApiEntityTag() {
  return applyDecorators(
    ApiHeader({
      name: "ETag",
      description: "Validator for the version returned. Send it back in `If-Match` to write.",
      required: false,
      schema: { type: "string", example: '"3"' },
    }),
  );
}

/**
 * Documents a mutating route guarded by `If-Match`.
 *
 * `required` mirrors the `@IfMatch()` option on the same handler: it decides
 * whether the header is advertised as mandatory and whether 428 is a documented
 * outcome. They are two declarations of one fact, so keep them in step.
 */
export function ApiConditionalWrite({ required = true }: { required?: boolean } = {}) {
  return applyDecorators(
    ApiHeader({
      name: "If-Match",
      description: IF_MATCH_DESCRIPTION,
      required,
      schema: { type: "string", example: '"3"' },
    }),
    ApiPreconditionFailedResponse({ description: PRECONDITION_FAILED_DESCRIPTION }),
    ...(required
      ? [ApiResponse({ status: 428, description: PRECONDITION_REQUIRED_DESCRIPTION })]
      : []),
    ApiEntityTag(),
  );
}
