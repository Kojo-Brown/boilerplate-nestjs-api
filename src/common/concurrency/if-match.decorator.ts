import { BadRequestException, createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { IF_MATCH_HEADER, UNCONDITIONAL, parseIfMatch } from "./entity-tag";
import type { ExpectedVersion } from "./entity-tag";
import { PreconditionRequiredException } from "./concurrency.exceptions";

/**
 * Binds the request's `If-Match` field to a parameter as an {@link ExpectedVersion}.
 *
 * ```ts
 * update(@Param("id") id: string, @IfMatch() expected: ExpectedVersion) { … }
 * ```
 *
 * Extraction only: an absent header yields `UNCONDITIONAL` rather than a
 * refusal. Demanding the header is {@link requireConditional}'s job, and it has
 * to happen later — see the note there.
 */
export const IfMatch = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ExpectedVersion =>
    resolveIfMatch(ctx.switchToHttp().getRequest<Request>()),
);

/**
 * The decorator's body, exported so it can be tested as a function.
 *
 * A `createParamDecorator` factory is otherwise only reachable through
 * `ROUTE_ARGS_METADATA`, and a test that digs it back out of Nest's metadata is
 * testing the framework's storage format as much as this rule.
 */
export function resolveIfMatch(request: Pick<Request, "headers">): ExpectedVersion {
  const raw = request.headers[IF_MATCH_HEADER];

  if (raw === undefined) return UNCONDITIONAL;

  // Node folds repeated non-`Set-Cookie` headers into one comma-joined string,
  // which is already the list syntax `If-Match` uses — so an array here means
  // something upstream rewrote the request, not that a client sent the header
  // twice.
  if (Array.isArray(raw)) {
    throw new BadRequestException("If-Match must be sent exactly once");
  }

  return parseIfMatch(raw);
}

/**
 * Refuses an unconditional write with 428.
 *
 * Deliberately *not* enforced by the parameter decorator, a guard, or an
 * interceptor, all three of which would be tidier to declare. Every one of them
 * runs before the handler's own checks, and RFC 9110 §13.2.1 requires the
 * opposite: preconditions are evaluated "after [the server] has successfully
 * performed its normal request checks and just before it would perform the
 * action associated with the request method". Enforced early, a request with a
 * malformed body and no `If-Match` answers 428, the client fixes the header,
 * and only then learns the body was wrong too — and one with neither the header
 * nor permission is told to retry conditionally on a resource it may not touch
 * at all.
 *
 * So it is called from the service, after validation, authorization and
 * existence, immediately before the write.
 */
export function requireConditional(expected: ExpectedVersion): void {
  if (expected.mode !== "unconditional") return;

  throw new PreconditionRequiredException(
    "If-Match is required on this endpoint. Read the resource first and send the ETag it returned.",
  );
}
