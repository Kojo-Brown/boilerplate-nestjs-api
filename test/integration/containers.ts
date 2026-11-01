/**
 * The servers the integration tier runs against, and the readers that fail
 * loudly when nothing started them.
 *
 * ## Why containers rather than services in the workflow
 *
 * The CI workflow already attaches a `postgres:17-alpine` and three
 * `redis:8-alpine` services to the `test` job, and for the suites that job runs
 * — `*.db-spec.ts`, and the real-Redis legs of the contract specs — that is the
 * cheaper mechanism. It is the wrong one for three reasons, all about where the
 * knowledge lives.
 *
 * A service block is a fact about the *workflow*. Nothing in the repository
 * says these suites need a server, so a clean clone either talks to whatever is
 * listening on 5432 — which on a working machine is a development database with
 * data in it — or reports four tests as `todo` and passes green. That second
 * one is the failure mode this tier exists to remove: `REDIS_URL` unset does
 * not fail the run, it silently removes the Redis half of the idempotency and
 * locking contracts from it.
 *
 * A service block also fixes the server *version* in the workflow, away from
 * the assertions that depend on it. {@link POSTGRES_IMAGE} and
 * {@link REDIS_IMAGE} are beside the suites instead.
 *
 * And a service cannot be stopped. The most interesting property Redlock has is
 * that a quorum survives a node that has genuinely gone away, and a service
 * container runs for the length of the job — so that leg is currently asserted
 * against `FakeRedisNode` with `down = true`, a stand-in for the thing under
 * test. A container can be stopped mid-suite, which is what
 * `distributed-lock.integration-spec.ts` does.
 *
 * ## How the values reach the suites
 *
 * `globalSetup` and the test files are different module registries — Jest gives
 * each test file a fresh one — so the only thing that crosses from the
 * containers to a suite is `process.env`. That is a documented Jest channel
 * rather than a trick, but it is an untyped one, which is what this module
 * narrows.
 *
 * The names it sets are the application's own (`DATABASE_URL`, `REDIS_URL`,
 * `REDLOCK_NODES`) rather than a parallel set invented for tests, so the tier
 * configures the code exactly the way a deployment does and the existing
 * `test/helpers/db.ts` works unchanged against it.
 */

/** Pinned so a rerun measures the same server. Matches `docker-compose.yml`. */
export const POSTGRES_IMAGE = "postgres:17-alpine";

/** Pinned for the same reason. Matches `docker-compose.yml` and the CI services. */
export const REDIS_IMAGE = "redis:8-alpine";

/**
 * Independent masters, because that is what Redlock is: a majority of nodes
 * that do not replicate to each other. Three is the smallest number for which
 * a majority is not trivially one node.
 */
export const REDIS_NODE_COUNT = 3;

function required(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") {
    throw new Error(
      `${name} is not set. The integration suites are run by \`pnpm test:integration\`, ` +
        "whose Jest config starts the containers in `globalSetup` and exports this " +
        "variable. Running one of these files under another config will not work, which " +
        "is why `*.integration-spec.ts` is matched by no other `testRegex`.",
    );
  }
  return value;
}

/** Connection string for the migrated application database. */
export function integrationDatabaseUrl(): string {
  return required("DATABASE_URL");
}

/** Every Redis node the run started, in a stable order. */
export function integrationRedisUrls(): string[] {
  const urls = required("REDLOCK_NODES")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");

  if (urls.length !== REDIS_NODE_COUNT) {
    throw new Error(
      `REDLOCK_NODES names ${urls.length} node(s); the integration tier starts ` +
        `${REDIS_NODE_COUNT}. Something other than this tier's \`globalSetup\` set it.`,
    );
  }
  return urls;
}

/** The first node, for the suites that only need one. */
export function integrationRedisUrl(): string {
  return integrationRedisUrls()[0] as string;
}
