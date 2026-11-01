import { CONTAINERS_GLOBAL } from "./global-setup";
import type { IntegrationContainers } from "./global-setup";

/**
 * Stops the servers the run was measured against.
 *
 * Testcontainers also starts a reaper that removes them if this never runs — a
 * crashed worker, a `SIGKILL` — so this is the ordinary path rather than the
 * only one. It is still explicit: the reaper's timeout is measured in seconds
 * after the socket closes, and four containers left running between local runs
 * are noticed as "my laptop is slow" rather than as leaked containers.
 *
 * The nodes are stopped in parallel and failures are not swallowed: a container
 * that cannot be stopped is worth a red run, because the next one will start
 * against whatever it left behind.
 */
export default async function globalTeardown(): Promise<void> {
  const containers = (globalThis as Record<string, unknown>)[CONTAINERS_GLOBAL] as
    IntegrationContainers | undefined;
  if (!containers) return;

  await Promise.all([containers.postgres.stop(), ...containers.redis.map((node) => node.stop())]);
}
