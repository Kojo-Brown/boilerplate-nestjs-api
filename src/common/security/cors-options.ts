import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { ETAG_HEADER } from "@/common/concurrency/entity-tag";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
} from "@/common/idempotency/idempotency-key";
import { CORRELATION_ID_HEADER } from "@/common/interceptors/logging.interceptor";
import { isWildcardOriginList, parseOriginList, type SecurityEnv } from "./security.env";

/**
 * Request headers a browser is allowed to send cross-origin.
 *
 * A preflight lists the headers the real request will carry and is refused
 * outright if any of them is missing from `Access-Control-Allow-Headers`, so
 * this list is not documentation — it is the set of features a browser client
 * can use at all. Every entry corresponds to something this API reads:
 * `Authorization` to the JWT guard, `Idempotency-Key` to the idempotency
 * interceptor, `If-Match` to the optimistic-concurrency endpoints, and
 * `x-correlation-id` to the logging interceptor, which honours a client's id
 * when one is sent.
 */
export const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "If-Match",
  "If-None-Match",
  IDEMPOTENCY_KEY_HEADER,
  CORRELATION_ID_HEADER,
] as const;

/**
 * Response headers a cross-origin caller is allowed to *read*.
 *
 * This one is easier to get wrong than the request list, because omitting an
 * entry breaks nothing at the network level: the header arrives, the fetch
 * succeeds, and `response.headers.get(...)` simply returns `null`. A browser
 * client would find `ETag` missing from every response and conclude this API
 * does not implement optimistic concurrency — it would have no way to send an
 * `If-Match` it was never shown. `Idempotency-Replayed` is here for the same
 * reason, and `Retry-After` so a client can honour the throttler's backoff
 * rather than inventing one.
 */
export const CORS_EXPOSED_HEADERS = [
  ETAG_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  CORRELATION_ID_HEADER,
  "Retry-After",
] as const;

/** The methods the versioned API actually routes. */
export const CORS_METHODS = ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] as const;

/**
 * Builds the CORS configuration from the validated environment.
 *
 * The origin check is a function rather than the array `cors` also accepts, for
 * two reasons. It reflects the *matched* origin rather than echoing the list,
 * which is what makes `Access-Control-Allow-Origin` a single value as the
 * specification requires. And it keeps a request with no `Origin` header —
 * curl, a health probe, a service-to-service call — out of the allowlist
 * question entirely: CORS is a browser mechanism, and refusing those would
 * refuse nothing an attacker cannot trivially do anyway while breaking every
 * non-browser client.
 */
export function buildCorsOptions(env: SecurityEnv): CorsOptions {
  const wildcard = isWildcardOriginList(env.ALLOWED_ORIGINS);
  const allowlist = new Set(wildcard ? [] : parseOriginList(env.ALLOWED_ORIGINS));

  return {
    origin: (requestOrigin, callback) => {
      if (requestOrigin === undefined) {
        callback(null, true);
        return;
      }

      if (wildcard) {
        // Reflected, not `*`. With credentials on, a literal `*` is rejected by
        // the browser rather than honoured, so echoing the caller's origin is
        // the only spelling of "any origin" that works at all — and it is why
        // this combination is refused in production by `refineSecurityEnv`
        // rather than left to look like it is doing something safe.
        callback(null, requestOrigin);
        return;
      }

      // An exact, case-sensitive comparison against the serialised origin. The
      // `Origin` header is already normalised by the browser that sent it, and
      // `refineSecurityEnv` has already rejected any allowlist entry that is
      // not in the same form, so there is nothing left to normalise here.
      //
      // A miss is `false`, never an `Error`. Passing an error to the callback
      // turns a disallowed preflight into a 500 through the exception filter:
      // the browser blocks the request either way, and the difference is
      // whether a page in a stranger's tab can fill this service's error logs
      // and its alerting with traffic it chose.
      callback(null, allowlist.has(requestOrigin) ? requestOrigin : false);
    },
    credentials: env.CORS_ALLOW_CREDENTIALS,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: env.CORS_MAX_AGE_SECONDS,
    // 204, so a preflight carries no body. The default `cors` uses is 204
    // already; it is pinned here because the alternative that gets reached for
    // when an old browser misbehaves — 200 with a body — would be wrapped by
    // `ResponseEnvelopeInterceptor` into a JSON envelope for a request that
    // asked for nothing.
    optionsSuccessStatus: 204,
  };
}
