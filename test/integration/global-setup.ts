import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { POSTGRES_IMAGE, REDIS_IMAGE, REDIS_NODE_COUNT } from "./containers";

const run = promisify(execFile);

/**
 * Handles handed to `global-teardown.ts`.
 *
 * Jest runs `globalSetup` and `globalTeardown` in the same process but in
 * separate module registries, so a module-level variable does not survive the
 * trip and a global does. This is the documented channel for exactly this.
 */
export interface IntegrationContainers {
  readonly postgres: StartedPostgreSqlContainer;
  readonly redis: readonly StartedRedisContainer[];
}

export const CONTAINERS_GLOBAL = "__INTEGRATION_CONTAINERS__";

/**
 * Starts the servers the integration tier is measured against and migrates the
 * database.
 *
 * ## Why the migrations run here
 *
 * Because they are slow, deterministic and identical for every file, and
 * because applying them to an *empty* database is itself worth asserting: the
 * `20260701000000_init` migration exists only because every migration in the
 * repository was once an `ALTER TABLE` against tables nothing created, and
 * `migrate deploy` failed on a clean database for weeks without anybody finding
 * out. This tier re-runs that proof on every invocation, from nothing, with no
 * volume to inherit a schema from.
 *
 * `prisma migrate deploy` is shelled out to rather than called in-process
 * because Prisma exposes no programmatic migration API — the CLI is the
 * supported entry point. `prisma.config.ts` reads `DATABASE_URL` from the
 * environment, which is why it is set before the call rather than passed as a
 * flag.
 *
 * ## Why the Redis nodes are started together
 *
 * `REDLOCK_NODES` has to name a majority for the quorum legs of the lock
 * contract to mean anything, and a majority of one node is not a quorum. The
 * three here do not replicate to each other, which is the property Redlock
 * assumes and the reason a single node with two replicas would not do:
 * replicated nodes are one node with copies, and a lock acknowledged before
 * replication is simply absent after a failover.
 */
export default async function globalSetup(): Promise<void> {
  const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("app_test")
    .withUsername("app_test")
    // Obviously fake, and local to a container destroyed at the end of the run.
    // Written here rather than defaulted so nothing in the tier reads like a
    // credential somebody might reuse.
    .withPassword("integration-test-password")
    .start();

  const redis = await Promise.all(
    Array.from({ length: REDIS_NODE_COUNT }, () => new RedisContainer(REDIS_IMAGE).start()),
  );

  const databaseUrl = postgres.getConnectionUri();
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["REDIS_URL"] = redis[0]?.getConnectionUrl() ?? "";
  process.env["REDLOCK_NODES"] = redis.map((node) => node.getConnectionUrl()).join(",");

  // `migrate deploy` applies the committed history and nothing else — it never
  // generates, never prompts and never resets, which is what makes it the right
  // command for a database the suite is about to assert the shape of.
  await run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    // The migration history is thirteen steps against a cold container; the
    // Jest-level `testTimeout` does not cover `globalSetup`.
    timeout: 120_000,
  });

  const containers: IntegrationContainers = { postgres, redis };
  (globalThis as Record<string, unknown>)[CONTAINERS_GLOBAL] = containers;
}
