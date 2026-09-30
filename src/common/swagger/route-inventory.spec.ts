import {
  documentedPathsOf,
  findInventoryViolations,
  listHttpRoutes,
  routeKey,
  toOpenApiPath,
  type HttpRoute,
  type InventoryPolicy,
} from "./route-inventory";

const EMPTY_POLICY: InventoryPolicy = { undocumented: [], unversioned: [] };

/**
 * The checker behind the API9:2023 inventory assertion in
 * `test/owasp-api-top10.e2e-spec.ts`.
 *
 * That spec runs it against the real application, where a passing result is the
 * outcome everyone wants and also the outcome a checker that never reports
 * anything produces. So the teeth are established here instead, against tables
 * written to be wrong in one specific way each.
 */
describe("findInventoryViolations", () => {
  const route = (method: string, path: string): HttpRoute => ({ method, path });

  it("passes a route that is published and versioned", () => {
    const routes = [route("GET", "/v1/users/:id")];

    expect(findInventoryViolations(routes, new Set(["GET /v1/users/{id}"]), EMPTY_POLICY)).toEqual(
      [],
    );
  });

  it("reports a reachable route the document does not publish", () => {
    const routes = [route("POST", "/v1/internal/rebuild-index")];

    expect(findInventoryViolations(routes, new Set(), EMPTY_POLICY)).toEqual([
      expect.objectContaining({
        route: "POST /v1/internal/rebuild-index",
        reason: "undocumented",
      }),
    ]);
  });

  it("accepts an undocumented route that the policy names", () => {
    const routes = [route("GET", "/v1/auth/google")];
    const policy: InventoryPolicy = { undocumented: ["GET /v1/auth/google"], unversioned: [] };

    expect(findInventoryViolations(routes, new Set(), policy)).toEqual([]);
  });

  it("reports a route served outside the version prefix", () => {
    const routes = [route("GET", "/legacy/users")];

    expect(findInventoryViolations(routes, new Set(["GET /legacy/users"]), EMPTY_POLICY)).toEqual([
      expect.objectContaining({ route: "GET /legacy/users", reason: "unversioned" }),
    ]);
  });

  it("accepts an unversioned route that the policy names", () => {
    const routes = [route("GET", "/metrics")];
    const policy: InventoryPolicy = { undocumented: [], unversioned: ["GET /metrics"] };

    expect(findInventoryViolations(routes, new Set(["GET /metrics"]), policy)).toEqual([]);
  });

  it("reports both reasons for one route when both apply", () => {
    const routes = [route("GET", "/debug/heap")];

    expect(findInventoryViolations(routes, new Set(), EMPTY_POLICY).map((v) => v.reason)).toEqual([
      "undocumented",
      "unversioned",
    ]);
  });

  /**
   * The failure mode an allowlist has that a denylist does not: the exemption
   * outlives the route. `GET /v1/auth/google` is deleted, the entry excusing it
   * stays, and the next route mounted on that path is published nowhere and
   * reported by nothing.
   */
  it("reports an exemption whose route is gone", () => {
    const policy: InventoryPolicy = {
      undocumented: ["GET /v1/auth/google"],
      unversioned: ["GET /metrics"],
    };

    expect(findInventoryViolations([], new Set(), policy)).toEqual([
      expect.objectContaining({ route: "GET /v1/auth/google", reason: "stale-exemption" }),
      expect.objectContaining({ route: "GET /metrics", reason: "stale-exemption" }),
    ]);
  });

  it("does not confuse a method on a documented path for a documented route", () => {
    const routes = [route("DELETE", "/v1/users/:id")];

    expect(findInventoryViolations(routes, new Set(["GET /v1/users/{id}"]), EMPTY_POLICY)).toEqual([
      expect.objectContaining({ route: "DELETE /v1/users/:id", reason: "undocumented" }),
    ]);
  });
});

describe("toOpenApiPath", () => {
  it.each([
    ["/v1/users", "/v1/users"],
    ["/v1/users/:id", "/v1/users/{id}"],
    ["/v1/users/:id/preferences", "/v1/users/{id}/preferences"],
    ["/v1/a/:one/b/:two", "/v1/a/{one}/b/{two}"],
  ])("converts %s", (express, openapi) => {
    expect(toOpenApiPath(express)).toBe(openapi);
  });
});

describe("routeKey", () => {
  it("names a route the way a policy entry does", () => {
    expect(routeKey({ method: "GET", path: "/v1/users/:id" })).toBe("GET /v1/users/:id");
  });
});

describe("documentedPathsOf", () => {
  it("pairs every method with its path, uppercased", () => {
    const document = {
      paths: {
        "/v1/users": { get: {}, post: {} },
        "/v1/users/{id}": { get: {} },
      },
    };

    expect(documentedPathsOf(document)).toEqual(
      new Set(["GET /v1/users", "POST /v1/users", "GET /v1/users/{id}"]),
    );
  });

  it("is empty for a document with no paths", () => {
    expect(documentedPathsOf({})).toEqual(new Set());
  });
});

describe("listHttpRoutes", () => {
  /** A stand-in for the adapter, since only `getInstance()` is reached. */
  const appWith = (instance: unknown) =>
    ({ getHttpAdapter: () => ({ getInstance: () => instance }) }) as never;

  it("reads Express 5's `router`", () => {
    const app = appWith({
      router: {
        stack: [
          { route: { path: "/v1/users/:id", methods: { get: true } } },
          { route: { path: "/v1/users", methods: { get: true, post: true } } },
          // Middleware layers have no `route`, and there are many of them.
          {},
        ],
      },
    });

    expect(listHttpRoutes(app)).toEqual([
      { method: "GET", path: "/v1/users" },
      { method: "POST", path: "/v1/users" },
      { method: "GET", path: "/v1/users/:id" },
    ]);
  });

  it("reads Express 4's `_router`", () => {
    const app = appWith({
      _router: { stack: [{ route: { path: "/v1/a", methods: { get: true } } }] },
    });

    expect(listHttpRoutes(app)).toEqual([{ method: "GET", path: "/v1/a" }]);
  });

  it("skips a method the route has switched off", () => {
    const app = appWith({
      router: { stack: [{ route: { path: "/v1/a", methods: { get: true, head: false } } }] },
    });

    expect(listHttpRoutes(app)).toEqual([{ method: "GET", path: "/v1/a" }]);
  });

  /**
   * The one failure this reader must not be quiet about. An empty inventory
   * satisfies every check in `findInventoryViolations`, so a router it cannot
   * find has to be an error rather than `[]`.
   */
  it("throws rather than report an empty inventory when it cannot find the router", () => {
    expect(() => listHttpRoutes(appWith({}))).toThrow(/Could not read the Express router/);
    expect(() => listHttpRoutes(appWith({ router: {} }))).toThrow(
      /Could not read the Express router/,
    );
  });
});
