import { Global, Module } from "@nestjs/common";
import { CacheModule as NestCacheModule } from "@nestjs/cache-manager";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CacheService } from "./cache.service";
import type { Env } from "@/config/env.schema";

@Global()
@Module({
  imports: [
    NestCacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (config: ConfigService<Env, true>) => {
        const redisUrl = config.get("REDIS_URL", { infer: true });
        if (redisUrl) {
          const { default: Keyv } = await import("keyv");
          const { default: KeyvRedis } = await import("@keyv/redis");
          return {
            stores: [new Keyv({ store: new KeyvRedis(redisUrl), ttl: 60_000 })],
          };
        }
        return { ttl: 60_000 };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [CacheService],
  exports: [CacheService],
})
export class AppCacheModule {}
