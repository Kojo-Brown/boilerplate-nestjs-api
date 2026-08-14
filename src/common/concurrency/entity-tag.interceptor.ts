import { Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { map } from "rxjs/operators";
import type { Observable } from "rxjs";
import type { Response } from "express";
import { ETAG_HEADER, formatEntityTag } from "./entity-tag";
import { isVersionedResource } from "./versioned-resource";

/**
 * Turns a {@link VersionedResource} returned by a handler into an `ETag` header
 * plus the plain body.
 *
 * Bound innermost of the global interceptors, so it unwraps before
 * `ResponseEnvelopeInterceptor` wraps: everything further out sees the ordinary
 * payload and needs to know nothing about versioning.
 *
 * Setting the header here also pre-empts Express, which generates its own weak
 * `ETag` in `res.send` — but only when none is already set. Left to itself it
 * would digest the envelope, whose `meta.timestamp` differs on every response,
 * producing a validator that changes without the resource changing.
 */
@Injectable()
export class EntityTagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((value: unknown) => {
        if (!isVersionedResource(value)) return value;
        res.setHeader(ETAG_HEADER, formatEntityTag(value.version));
        return value.body;
      }),
    );
  }
}
