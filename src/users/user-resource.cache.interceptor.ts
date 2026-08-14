import { Injectable } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { HttpCacheInterceptor } from "@/common/cache";
import { userCacheKey } from "./users.service";

/**
 * Caches `GET /users/:id` under the key `UsersService` invalidates.
 *
 * The base interceptor tracks by request URL, so the entry for
 * `GET /v1/users/abc` was stored as `"/v1/users/abc"` while
 * `invalidateUserCache` deleted `"v1:users:abc"` — two keys in one store that
 * were never going to meet. Every write left the read cached, for the full 30s
 * TTL, showing the state before the update.
 *
 * That was already a correctness bug, and optimistic concurrency makes it a
 * loud one: the stale response now carries a stale `ETag`, so a client that
 * reads, edits and writes inside the TTL is refused with 412 against a version
 * that no longer exists, and retrying re-reads the same stale value. Aligning
 * the key is what makes the read-modify-write loop terminate.
 *
 * `@CacheKey()` cannot express this — it pins a route to one constant, which
 * would serve every user the first one fetched.
 */
@Injectable()
export class UserResourceCacheInterceptor extends HttpCacheInterceptor {
  protected override trackBy(context: ExecutionContext): string | undefined {
    const req = context.switchToHttp().getRequest<Request>();
    const id = (req.params as Record<string, string | undefined> | undefined)?.["id"];
    // No id means this is not the route this interceptor was written for.
    // Returning `undefined` skips the cache rather than inventing a key.
    return id ? userCacheKey(id) : undefined;
  }
}
