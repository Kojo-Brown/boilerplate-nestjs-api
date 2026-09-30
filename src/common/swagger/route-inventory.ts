import type { INestApplication } from "@nestjs/common";
import { SWAGGER_PATH } from "./setup-swagger";

/**
 * One route the application will actually answer.
 *
 * `path` is the mounted path with Nest's version prefix already on it and the
 * parameters still in `:id` form — the shape Express matched on, not the shape
 * OpenAPI writes. {@link toOpenApiPath} converts.
 */
export interface HttpRoute {
  readonly method: string;
  readonly path: string;
}

/** What {@link findInventoryViolations} was given to check the routes against. */
export interface InventoryPolicy {
  /**
   * Routes that are deliberately absent from the published document, as
   * `"METHOD /path"`.
   *
   * Every entry is a route somebody decided not to publish — Passport's OAuth
   * redirect pair, which no client calls directly and which carry
   * `@ApiExcludeEndpoint()`. An undocumented route that is *not* listed here is
   * the thing this check exists to find.
   */
  readonly undocumented: readonly string[];
  /**
   * Paths served outside the `/v1` prefix, as `"METHOD /path"`.
   *
   * `VERSION_NEUTRAL` is the right answer for exactly one kind of route — one
   * whose client is a machine pointed at a well-known path — and the wrong
   * answer for every REST resource. Listing them makes each one a decision.
   */
  readonly unversioned: readonly string[];
}

/** A route that does not match the policy, and why. */
export interface InventoryViolation {
  readonly route: string;
  readonly reason: "undocumented" | "unversioned" | "stale-exemption";
  readonly detail: string;
}

const VERSION_PREFIX = "/v1/";

/**
 * Reads the routes the HTTP adapter will match.
 *
 * Off the Express router rather than off Nest's metadata, deliberately: what a
 * route inventory has to be right about is what the process will answer, and the
 * decorators are one transformation away from that. A controller whose module is
 * never imported carries all its metadata and routes nothing.
 *
 * Express 5 exposes the application's router as `app.router`; Express 4 kept it
 * on `app._router`, and both are read so that a major-version bump surfaces as a
 * failing assertion here rather than as an inventory that silently finds no
 * routes at all — which would pass every check in {@link findInventoryViolations}.
 */
export function listHttpRoutes(app: INestApplication): HttpRoute[] {
  const instance = app.getHttpAdapter().getInstance() as Record<string, unknown>;
  const router = (instance["router"] ?? instance["_router"]) as
    { stack?: RouterLayer[] } | undefined;
  const stack = router?.stack;
  if (!Array.isArray(stack)) {
    throw new Error(
      "Could not read the Express router: neither `app.router` nor `app._router` has a `stack`. " +
        "The route inventory in src/common/swagger/route-inventory.ts needs updating for this " +
        "version of Express.",
    );
  }

  return stack
    .flatMap<HttpRoute>((layer) => {
      const path = layer.route?.path;
      if (path === undefined) return [];
      return Object.entries(layer.route?.methods ?? {})
        .filter(([, enabled]) => enabled)
        .map(([method]) => ({ method: method.toUpperCase(), path }));
    })
    .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

interface RouterLayer {
  readonly route?: {
    readonly path?: string;
    readonly methods?: Record<string, boolean>;
  };
}

/** `"GET /v1/users/:id"` — how a route is named in a policy and in a violation. */
export function routeKey(route: HttpRoute): string {
  return `${route.method} ${route.path}`;
}

/**
 * Express's `:id` in OpenAPI's `{id}`.
 *
 * The two notations describe the same route, and comparing them without
 * converting is how an inventory check reports every parameterised route as
 * undocumented — which reads as a catastrophe and means nothing.
 */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Every route that is reachable but not accounted for.
 *
 * Three questions, because there are three ways an inventory drifts (OWASP
 * API9:2023): a route nobody published, a route outside the versioning scheme,
 * and an exemption that outlived the route it was written for. The third matters
 * as much as the others — a stale entry in `undocumented` is a standing licence
 * for the next route that happens to take the same path.
 *
 * Pure, and takes the document rather than the app, so the check can be run
 * against a table somebody made up. That is what `route-inventory.spec.ts` does:
 * a checker that reports nothing is indistinguishable from a checker that works
 * until it is shown something broken.
 */
export function findInventoryViolations(
  routes: readonly HttpRoute[],
  documentedPaths: ReadonlySet<string>,
  policy: InventoryPolicy,
): InventoryViolation[] {
  const violations: InventoryViolation[] = [];
  const present = new Set(routes.map(routeKey));

  for (const route of routes) {
    const key = routeKey(route);

    if (!documentedPaths.has(`${route.method} ${toOpenApiPath(route.path)}`)) {
      if (!policy.undocumented.includes(key)) {
        violations.push({
          route: key,
          reason: "undocumented",
          detail:
            "reachable but absent from the OpenAPI document; publish it, or add it to the " +
            "documented exemptions with a reason",
        });
      }
    }

    if (!route.path.startsWith(VERSION_PREFIX) && !policy.unversioned.includes(key)) {
      violations.push({
        route: key,
        reason: "unversioned",
        detail: `served outside ${VERSION_PREFIX}; version it, or list it as version-neutral`,
      });
    }
  }

  for (const exempt of [...policy.undocumented, ...policy.unversioned]) {
    if (!present.has(exempt)) {
      violations.push({
        route: exempt,
        reason: "stale-exemption",
        detail: "exempted by the policy but no longer routed; drop the exemption",
      });
    }
  }

  return violations;
}

/**
 * The `"METHOD /path"` set an OpenAPI document publishes.
 *
 * The document's own paths, uppercased and paired with their methods, so
 * {@link findInventoryViolations} can compare like with like. `SWAGGER_PATH`
 * itself is never in here: Swagger's UI is mounted on the Express instance
 * directly, outside Nest's router, so it is not in the inventory either and the
 * two stay consistent without a special case.
 */
export function documentedPathsOf(document: { paths?: Record<string, object> }): Set<string> {
  const documented = new Set<string>();
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(operations)) {
      documented.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return documented;
}

/** Where the docs are served, re-exported so a caller needs one import. */
export { SWAGGER_PATH };
