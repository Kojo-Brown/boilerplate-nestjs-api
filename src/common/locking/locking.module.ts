import { Global, Logger, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DISTRIBUTED_LOCK } from "./ports";
import type { DistributedLock } from "./ports";
import { InMemoryDistributedLock } from "./in-memory-distributed-lock";
import { RedlockService } from "./redlock.service";
import type { Env } from "@/config/env.schema";

/**
 * Splits `REDLOCK_NODES` into the independent Redis masters Redlock votes over.
 *
 * Exported because `env.schema.ts` validates the same string at boot, and two
 * different ideas of what separates a URL would mean a deployment that
 * validates and then locks against the wrong set of nodes.
 */
export function parseRedlockNodes(raw: string): string[] {
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * The only file that knows which lock implementations exist.
 *
 * `DISTRIBUTED_LOCK` picks one at boot and nothing downstream — `AspectWeaver`
 * and every `withLock()` call site included — names an implementation (DIP).
 *
 * Only the selected one is constructed: building the Redlock service opens a
 * socket per node, and a deployment running on the in-memory lock must not hold
 * connections to a cluster it never talks to.
 */
export async function createDistributedLock(
  config: ConfigService<Env, true>,
): Promise<DistributedLock> {
  const selected = config.get("DISTRIBUTED_LOCK", { infer: true });
  const logger = new Logger(RedlockService.name);

  if (selected === "memory") {
    return new InMemoryDistributedLock();
  }

  // `env.schema.ts` requires one of these whenever this branch is selected, so
  // the assertion is the schema's guarantee rather than an assumption.
  const configured =
    config.get("REDLOCK_NODES", { infer: true }) ??
    (config.get("REDIS_URL", { infer: true }) as string);
  const urls = parseRedlockNodes(configured);

  if (urls.length < 3) {
    // Not refused, because a single node is a reasonable development setup and
    // because two is what a deployment looks like halfway through adding a
    // third. It is said out loud because the algorithm's whole claim is
    // surviving the loss of a minority, and a minority of one is zero: with
    // fewer than three nodes, one failure takes every lock with it — and a
    // restarted node comes back empty, so it grants keys it had already
    // granted.
    logger.warn(
      `Redlock is configured with ${urls.length} node(s). Three or more independent Redis ` +
        "masters are what make it tolerant of losing one; below that it is a single point of " +
        "failure. See docs/distributed-locking.md.",
    );
  }

  // Imported here rather than at module scope so a deployment on the in-memory
  // lock never loads the driver at all.
  const { Redis } = await import("ioredis");

  const nodes = urls.map((url, index) =>
    new Redis(url, {
      // A queued command against a dead node would sit there until the client
      // reconnects, turning "one node is down" — the case Redlock exists to
      // survive — into "every acquisition waits for it". Failing fast lets the
      // vote be counted without it.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    }).on("error", (error: Error) => {
      // ioredis emits `error` on every reconnect attempt, and an unhandled
      // `error` on an EventEmitter is a process crash — which would make one
      // unreachable node fatal to the application.
      logger.error(`Redis node ${index} (${redactCredentials(url)}): ${error.message}`);
    }),
  );

  // `enableOfflineQueue: false` means a command issued before the socket is up
  // fails instead of queueing, so without this the first acquisition after a
  // deploy could be refused on every node at once — a lock that is unavailable
  // for the first few milliseconds of every process's life. Waiting here costs
  // nothing when the nodes are up and is bounded when they are not: a node that
  // never becomes ready must not stop the application from booting.
  await Promise.all(nodes.map((node) => waitForReady(node, READY_TIMEOUT_MS)));

  return new RedlockService(nodes, { logger });
}

const READY_TIMEOUT_MS = 2_000;

function waitForReady(
  node: { status: string; once: (event: string, listener: () => void) => void },
  ms: number,
): Promise<void> {
  if (node.status === "ready") return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    node.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Keeps a `redis://user:password@host` out of the log. */
function redactCredentials(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***@");
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DISTRIBUTED_LOCK,
      useFactory: createDistributedLock,
      inject: [ConfigService],
    },
  ],
  exports: [DISTRIBUTED_LOCK],
})
export class LockingModule {}
