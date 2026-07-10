import { Inject, Injectable } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import type { Cache } from "cache-manager";

@Injectable()
export class CacheService {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  set<T>(key: string, value: T, ttl?: number): Promise<void> {
    return this.cache.set(key, value, ttl);
  }

  del(key: string): Promise<void> {
    return this.cache.del(key);
  }

  async delMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.cache.del(k)));
  }

  reset(): Promise<void> {
    return this.cache.reset();
  }
}
