import type { OpenAPIObject } from "@nestjs/swagger";
import { MAX_KEY_LENGTH } from "./idempotency-key";

/**
 * Documents `Idempotency-Key` on every operation that honours it.
 *
 * Done to the finished document rather than with a decorator, because the
 * interceptor is bound globally and keys off the HTTP method: a decorator would
 * have to be repeated on every mutating route and would go stale the first time
 * someone added one without it. This cannot — the same rule that decides
 * whether a request participates decides whether it is documented.
 *
 * `DocumentBuilder.addGlobalParameters` was the alternative and is wrong here:
 * it would advertise the header on `GET` too, where sending it does nothing.
 */
const MUTATING_METHODS = ["post", "put", "patch", "delete"] as const;

const HEADER_DESCRIPTION = [
  "Opt-in idempotency. Send a unique key (a UUID is ideal) and this request can be",
  "retried safely: the first attempt runs, and every later attempt with the same key",
  "receives that first response verbatim, marked `Idempotency-Replayed: true`.",
  "Keys are scoped to the caller and expire after 24 hours by default.",
].join(" ");

const CONFLICT_DESCRIPTION =
  "A request with this Idempotency-Key is still being processed. Retry shortly.";

const UNPROCESSABLE_DESCRIPTION =
  "This Idempotency-Key has already been used for a different request.";

/** Mutates `document` in place and returns it, the way `createDocument` hands it over. */
export function documentIdempotency(document: OpenAPIObject): OpenAPIObject {
  // `paths` is required by the spec but optional in the type, and an
  // application with no routes at all produces a document without it.
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of MUTATING_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      operation.parameters = [
        ...(operation.parameters ?? []),
        {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: HEADER_DESCRIPTION,
          schema: { type: "string", maxLength: MAX_KEY_LENGTH },
        },
      ];

      // Never overwrite a status the route documents itself — a route with its
      // own 422 means something more specific by it than this does.
      operation.responses = {
        ...{
          "409": { description: CONFLICT_DESCRIPTION },
          "422": { description: UNPROCESSABLE_DESCRIPTION },
        },
        ...operation.responses,
      };
    }
  }

  return document;
}
