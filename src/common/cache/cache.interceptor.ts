import { ExecutionContext, Injectable } from "@nestjs/common";
import { CacheInterceptor } from "@nestjs/cache-manager";
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
}
