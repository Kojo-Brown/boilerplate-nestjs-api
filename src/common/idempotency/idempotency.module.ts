import { Global, Logger, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { IDEMPOTENCY_STORE } from "./ports";
import type { IdempotencyStore } from "./ports";
import { InMemoryIdempotencyStore } from "./stores/in-memory-idempotency.store";
import { RedisIdempotencyStore } from "./stores/redis-idempotency.store";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import type { Env } from "@/config/env.schema";

/**
 * The only file that knows which dedupe backends exist.
 *
 * `IDEMPOTENCY_STORE` picks one at boot and nothing downstream — the
 * interceptor included — names an implementation (DIP). Adding a third backend
 * is a class, a case here, and a name in `IDEMPOTENCY_STORE_NAMES`.
 *
 * Unlike `StorageModule`, only the selected store is constructed: building the
 * Redis one opens a socket, and a deployment that runs on the in-memory store
 * must not hold a connection to a Redis it never uses.
 */
export async function createIdempotencyStore(
  config: ConfigService<Env, true>,
): Promise<IdempotencyStore> {
  const selected = config.get("IDEMPOTENCY_STORE", { infer: true });

  if (selected === "memory") {
    return new InMemoryIdempotencyStore();
  }

  // `env.schema.ts` requires REDIS_URL whenever this branch is selected, so the
  // assertion is the schema's guarantee rather than an assumption.
  const url = config.get("REDIS_URL", { infer: true }) as string;

  // Imported here rather than at module scope so a deployment on the in-memory
  // store never loads the driver at all.
  const { Redis } = await import("ioredis");

  return new RedisIdempotencyStore(
    new Redis(url, {
      // The interceptor already fails closed on a store error, and a command
      // queued against a dead connection would sit there until the client
      // reconnects — turning "Redis is down" into "every mutating request
      // hangs" instead of "every mutating request 503s".
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    }).on("error", (error: Error) => {
      // ioredis emits `error` on every reconnect attempt, and an unhandled
      // `error` on an EventEmitter is a process crash.
      new Logger(RedisIdempotencyStore.name).error(`Redis connection error: ${error.message}`);
    }),
  );
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: createIdempotencyStore,
      inject: [ConfigService],
    },
    IdempotencyInterceptor,
  ],
  exports: [IDEMPOTENCY_STORE, IdempotencyInterceptor],
})
export class IdempotencyModule {}
