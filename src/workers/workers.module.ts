import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";
import type { WorkerPool } from "./ports/worker-pool.port";
import { WORKER_POOL } from "./ports/worker-pool.port";
import { InlineWorkerPool } from "./inline-worker-pool";
import { PiscinaWorkerPool } from "./piscina-worker-pool";

/**
 * Drains the pool on `SIGTERM`. Kept next to the module so a shutdown
 * dependency is not silently forgotten if `AppModule` picks the pool up
 * without also picking this up.
 */
@Injectable()
class WorkerPoolShutdownHook implements OnApplicationShutdown {
  private readonly logger = new Logger("WorkerPoolShutdownHook");

  constructor(@Inject(WORKER_POOL) private readonly pool: WorkerPool) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log("draining worker pool");
    await this.pool.shutdown();
  }
}

/**
 * Provides the process's single `WORKER_POOL`.
 *
 * Global for the same reason `LockingModule` is: a pool is a scarce
 * process-scoped resource and two of them defeat the point of a bounded
 * queue. The factory picks Piscina or the inline stand-in from
 * `WORKER_POOL`, and the shutdown hook drains whichever it built — a pool
 * that outlives the Nest container keeps a `worker_threads` reference alive
 * long enough to stall `process.exit`.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: WORKER_POOL,
      useFactory: (config: ConfigService<Env, true>): WorkerPool => {
        const backend = config.get("WORKER_POOL", { infer: true });
        const maxThreads = config.get("WORKER_POOL_MAX_THREADS", { infer: true });
        const maxQueue = config.get("WORKER_POOL_MAX_QUEUE", { infer: true });
        const taskTimeoutMs = config.get("WORKER_POOL_TASK_TIMEOUT_MS", { infer: true });
        const logger = new Logger("WorkersModule");
        if (backend === "piscina") {
          logger.log(
            `piscina pool: maxThreads=${maxThreads} maxQueue=${maxQueue} timeoutMs=${taskTimeoutMs}`,
          );
          return new PiscinaWorkerPool({ maxThreads, maxQueue, taskTimeoutMs });
        }
        logger.log(
          `inline pool: maxQueue=${maxQueue} timeoutMs=${taskTimeoutMs} (no thread offload)`,
        );
        return new InlineWorkerPool({ maxThreads, maxQueue, taskTimeoutMs });
      },
      inject: [ConfigService],
    },
    WorkerPoolShutdownHook,
  ],
  exports: [WORKER_POOL],
})
export class WorkersModule {}
