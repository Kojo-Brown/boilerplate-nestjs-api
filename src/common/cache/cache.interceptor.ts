import { ExecutionContext, Injectable } from "@nestjs/common";
import { CacheInterceptor, CACHE_KEY_METADATA } from "@nestjs/cache-manager";
import type { Request } from "express";

/**
 * Extends the built-in CacheInterceptor to only cache GET requests.
 * Subclasses can override `trackBy` to customise the cache key strategy.
 */
@Injectable()
export class HttpCacheInterceptor extends CacheInterceptor {
  protected override isRequestCacheable(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    return req.method === "GET";
  }

  /**
   * `@CacheKey()` pins a route to one constant key, which is what makes targeted
   * invalidation possible — but it also means every request to that route shares
   * a single entry, so `GET /users?limit=1` would be served the unfiltered list.
   *
   * Parameterised requests therefore bypass the cache entirely (returning
   * `undefined` tells the base interceptor to skip it). Routes with no explicit
   * key keep the default behaviour, which already tracks by full URL.
   */
  protected override trackBy(context: ExecutionContext): string | undefined {
    const declaredKey = this.reflector.get<string | undefined>(
      CACHE_KEY_METADATA,
      context.getHandler(),
    );
    if (!declaredKey) {
      return super.trackBy(context) as string | undefined;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const hasQuery = Object.keys(req.query ?? {}).length > 0;
    return hasQuery ? undefined : declaredKey;
  }
}
