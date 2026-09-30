import type { INestApplication } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { RolesGuard } from "@/auth/guards/roles.guard";
import { UserAccessPolicy } from "@/users/users.access-policy";
import { toUserResponse } from "@/users/dto/user-response.dto";
import { IDEMPOTENCY_KEY_HEADER } from "@/common/idempotency";
import {
  documentedPathsOf,
  findInventoryViolations,
  listHttpRoutes,
  routeKey,
  type InventoryPolicy,
} from "@/common/swagger/route-inventory";
import { EVENT_HEADERS, decodeDomainEvent } from "@/messaging/domain-event-codec";
import { SchemaContractViolationError } from "@/messaging/messaging.errors";
import type { IncomingMessage } from "@/messaging/ports";
import { realEventContract } from "@/test-utils/event-contract";
import { StripePaymentProvider } from "@/payments/providers/stripe-payment.provider";
import { stubConfig } from "@/test-utils/stub-config";
import { testHttpClient } from "@/test-utils/test-http-client";

/**
 * The OWASP API Security Top 10 (2023), one `describe` per risk, and a mitigation
 * this application actually has behind each one.
 *
 * Every risk is covered twice, and the second half is the point. A security
 * assertion passes for two reasons — the mitigation works, or the attack was
 * never going to land here for some incidental reason, most often that the
 * request was rejected a step earlier for a reason nobody wrote down. A suite
 * made only of the first kind grows a quiet majority of the second, and the day
 * somebody deletes a guard it stays green.
 *
 * So each risk gets:
 *
 *  - **`mitigated:`** the attack, against the application as deployed, refused.
 *  - **`negative control:`** the same attack with that one mitigation removed,
 *    landing. This is the "failing" half of failing-then-passing, kept in the
 *    suite instead of performed once by hand and described in a commit message.
 *
 * The control removes exactly one thing. A guard's `canActivate` is stubbed for
 * the length of one test; a projection is compared against the row it was built
 * from; a rate limiter or a header middleware — bound before `init()` and so not
 * reachable from inside a running app — gets a second application built without
 * it. What the control must never do is rewrite the attack: both halves send the
 * same request, so a difference in the answer is attributable to the mitigation
 * and to nothing else.
 *
 * `docs/owasp-api-top10.md` is the checklist this file backs, risk by risk,
 * including the two rows it cannot claim are closed.
 */
describe("OWASP API Security Top 10 (e2e)", () => {
  let fixture: TestApp;
  let app: INestApplication;
  let prisma: InMemoryPrismaService;

  let userToken: string;
  let userId: string;
  let adminToken: string;
  let victimId: string;

  const PASSWORD = process.env["E2E_TEST_PASSWORD"]!;

  /**
   * A structurally valid JWT claiming `ADMIN`, with a signature that is not one.
   *
   * Assembled here rather than written out as a literal: a JWT-shaped constant in
   * a repository is a finding for every secret scanner there is, and the only way
   * to carry one is to exempt the file it lives in from scanning — which is a
   * worse trade than three lines of base64url.
   */
  const FORGED_JWT = [
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", email: "forged@example.test", role: Role.ADMIN },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat(Buffer.from("not a signature over the above").toString("base64url"))
    .join(".");

  const http = () => request(app.getHttpServer());

  async function register(email: string, name: string): Promise<string> {
    const response = await http()
      .post("/v1/auth/register")
      .send({ email, password: PASSWORD, name });
    expect(response.status).toBe(HttpStatus.CREATED);
    return response.body.data.accessToken as string;
  }

  const idOf = (email: string): string =>
    [...prisma._users.values()].find((user) => user.email === email)!.id;

  async function etagOf(path: string, token: string): Promise<string> {
    const response = await http().get(path).set("Authorization", `Bearer ${token}`);
    return response.headers["etag"] ?? '"0"';
  }

  beforeAll(async () => {
    fixture = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    prisma.reset();
    // The warehouse, the carrier and the order book are process-scoped and
    // shared by every spec in this file.
    fixture.orders.reset();
    fixture.inventory.reset();
    fixture.shipping.reset();

    userToken = await register("attacker@example.test", "Attacker");
    userId = idOf("attacker@example.test");

    await register("victim@example.test", "Victim");
    victimId = idOf("victim@example.test");

    await register("admin@example.test", "Admin");
    const adminId = idOf("admin@example.test");
    await prisma.user.update({ where: { id: adminId }, data: { role: Role.ADMIN } });
    // Re-issued, because the role is a claim in the token rather than a lookup.
    const login = await http()
      .post("/v1/auth/login")
      .send({ email: "admin@example.test", password: PASSWORD });
    adminToken = login.body.data.accessToken as string;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── API1:2023 — Broken Object Level Authorization ──────────────────────────
  //
  // The object is another user's row. `UserAccessPolicy` answers "is it yours?",
  // which a guard cannot: the answer depends on the resource id, so it lives in
  // the handler that has one. See `src/users/users.access-policy.ts`.
  describe("API1:2023 Broken Object Level Authorization", () => {
    it("mitigated: reading another user's preferences is refused", async () => {
      const response = await http()
        .get(`/v1/users/${victimId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("mitigated: writing another user's profile is refused", async () => {
      const response = await http()
        .patch(`/v1/users/${victimId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", await etagOf(`/v1/users/${victimId}`, userToken))
        .send({ name: "Owned" });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(prisma._users.get(victimId)?.name).toBe("Victim");
    });

    it("mitigated: an admin may act on any user, so the rule is ownership and not identity", async () => {
      const response = await http()
        .patch(`/v1/users/${victimId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("If-Match", await etagOf(`/v1/users/${victimId}`, adminToken))
        .send({ name: "Renamed by admin" });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it("negative control: with the ownership check stubbed out, both requests land", async () => {
      const etag = await etagOf(`/v1/users/${victimId}`, userToken);
      jest.spyOn(UserAccessPolicy.prototype, "canAct").mockReturnValue(true);

      const read = await http()
        .get(`/v1/users/${victimId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`);
      const write = await http()
        .patch(`/v1/users/${victimId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "Owned" });

      expect(read.status).toBe(HttpStatus.OK);
      expect(write.status).toBe(HttpStatus.OK);
      expect(prisma._users.get(victimId)?.name).toBe("Owned");
    });
  });

  // ── API2:2023 — Broken Authentication ──────────────────────────────────────
  //
  // `JwtAuthGuard` is a global `APP_GUARD` (see `src/app.module.ts`), so a route
  // is authenticated unless it says otherwise. The signature is checked against
  // `JWT_SECRET` by `JwtStrategy`; refresh tokens are single-use and a replay
  // revokes the whole family (`docs/refresh-token-rotation.md`).
  describe("API2:2023 Broken Authentication", () => {
    it.each([
      ["no Authorization header", undefined],
      ["a bearer token that is not a JWT", "Bearer not-a-jwt"],
      ["a JWT signed with a key that is not this application's", `Bearer ${FORGED_JWT}`],
    ])("mitigated: %s is refused", async (_case, header) => {
      const call = http().get(`/v1/users/${victimId}`);
      const response = header === undefined ? await call : await call.set("Authorization", header);

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("mitigated: a spent refresh token cannot be replayed, and replaying it ends the session", async () => {
      const login = await http()
        .post("/v1/auth/login")
        .send({ email: "victim@example.test", password: PASSWORD });
      const spent = login.body.data.refreshToken as string;

      const rotated = await http().post("/v1/auth/refresh").send({ refreshToken: spent });
      expect(rotated.status).toBe(HttpStatus.OK);
      const replacement = rotated.body.data.refreshToken as string;

      // The replay itself.
      const replay = await http().post("/v1/auth/refresh").send({ refreshToken: spent });
      expect(replay.status).toBe(HttpStatus.UNAUTHORIZED);

      // And the token the legitimate client is holding is now dead too: the
      // application cannot tell which of the two parties is the thief, so it
      // ends the session rather than guess.
      const afterRevocation = await http()
        .post("/v1/auth/refresh")
        .send({ refreshToken: replacement });
      expect(afterRevocation.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("negative control: with the global guard stubbed out, an anonymous request is served", async () => {
      jest.spyOn(JwtAuthGuard.prototype, "canActivate").mockReturnValue(true);

      const response = await http().get(`/v1/users/${victimId}`);

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  // ── API3:2023 — Broken Object Property Level Authorization ─────────────────
  //
  // Two directions, and this application needed work in both. Outbound:
  // `toUserResponse` publishes a written list of fields, which the users resource
  // did not have — `GET /v1/users/:id` answered any authenticated caller with the
  // target's argon2 hash. Inbound: `ValidationPipe({ whitelist,
  // forbidNonWhitelisted })` refuses a property no DTO declares, so `role` in a
  // profile patch is a 400 rather than a privilege escalation.
  describe("API3:2023 Broken Object Property Level Authorization", () => {
    it.each([
      // The profile read, by a caller who is not the target: the request that
      // was handing out an argon2 hash.
      ["the profile read", () => `/v1/users/${victimId}`, () => userToken],
      ["the admin list", () => "/v1/users", () => adminToken],
    ])("mitigated: %s publishes no column that is not on the DTO", async (_case, path, token) => {
      const response = await http().get(path()).set("Authorization", `Bearer ${token()}`);

      expect(response.status).toBe(HttpStatus.OK);
      const payload = JSON.stringify(response.body);
      expect(payload).not.toContain("password");
      expect(payload).not.toContain("$argon2");
      expect(payload).not.toContain("providerAccountId");
    });

    it("mitigated: an unknown property in the body is refused rather than ignored", async () => {
      const response = await http()
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", await etagOf(`/v1/users/${userId}`, userToken))
        .send({ name: "Renamed", role: Role.ADMIN });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toEqual(
        expect.arrayContaining([expect.stringContaining("role")]),
      );
      expect(prisma._users.get(userId)?.role).toBe(Role.USER);
    });

    /**
     * The control for the outbound half, and it needs no second application:
     * the row the projection was built from is right there. A mapper that had
     * quietly started spreading the row — which is the regression this guards —
     * makes the two sides of this equal.
     */
    it("negative control: the row the projection is built from does carry the secrets", () => {
      const row = prisma._users.get(victimId)!;

      expect(row.password).toMatch(/^\$argon2/);
      expect(Object.keys(row)).toContain("providerAccountId");
      expect(Object.keys(toUserResponse(row))).not.toContain("password");
      expect(Object.keys(toUserResponse(row))).not.toContain("providerAccountId");
      // `preferences` has an endpoint of its own that checks ownership. While it
      // rode along on the profile response, that check was decoration.
      expect(Object.keys(toUserResponse(row))).not.toContain("preferences");
    });
  });

  // ── API4:2023 — Unrestricted Resource Consumption ──────────────────────────
  //
  // Page size is capped by `CursorPaginationDto` (`@Max(100)`), and the login
  // route is rate limited to 5 calls a minute by `@Throttle` over
  // `ProxyAwareThrottlerGuard`.
  describe("API4:2023 Unrestricted Resource Consumption", () => {
    it("mitigated: a page larger than the maximum is refused, not clamped", async () => {
      const response = await http()
        .get("/v1/users?limit=5000")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    /**
     * The shared fixture answers every request as the first hit — a suite makes
     * far more auth calls per minute than any client — so the limiter is only
     * observable against an application built with the production storage.
     * That second application is also the control: the two differ in the storage
     * and in nothing else.
     */
    describe("the login rate limit", () => {
      const LIMIT = 5;
      const attempts = LIMIT + 1;

      async function loginRepeatedly(target: TestApp): Promise<number[]> {
        const statuses: number[] = [];
        for (let i = 0; i < attempts; i += 1) {
          const response = await request(target.app.getHttpServer())
            .post("/v1/auth/login")
            .send({ email: "nobody@example.test", password: PASSWORD });
          statuses.push(response.status);
        }
        return statuses;
      }

      it("mitigated: the sixth attempt in the window is refused with 429", async () => {
        const limited = await createTestApp({ rateLimiting: "real" });
        try {
          const statuses = await loginRepeatedly(limited);

          expect(statuses.slice(0, LIMIT)).not.toContain(HttpStatus.TOO_MANY_REQUESTS);
          expect(statuses[LIMIT]).toBe(HttpStatus.TOO_MANY_REQUESTS);
        } finally {
          await limited.app.close();
        }
      });

      it("negative control: with the limiter neutralised, the same attempts all get through", async () => {
        const statuses = await loginRepeatedly(fixture);

        expect(statuses).not.toContain(HttpStatus.TOO_MANY_REQUESTS);
        // Every one of them reached the credential check, which is what makes
        // the 429 above attributable to the limiter rather than to the
        // credentials being wrong.
        expect(new Set(statuses)).toEqual(new Set([HttpStatus.UNAUTHORIZED]));
      });
    });
  });

  // ── API5:2023 — Broken Function Level Authorization ────────────────────────
  //
  // `RolesGuard` is global, and every admin-only handler carries `@Roles`. The
  // second half of this risk is the route nobody remembered to protect, which is
  // why the public surface is pinned below rather than left to a convention.
  describe("API5:2023 Broken Function Level Authorization", () => {
    it.each([
      ["listing every user", "/v1/users"],
      ["reading the audit log", "/v1/audit-log"],
    ])("mitigated: %s is refused to a non-admin", async (_case, path) => {
      const response = await http().get(path).set("Authorization", `Bearer ${userToken}`);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("mitigated: deleting a user is refused to a non-admin", async () => {
      const response = await http()
        .delete(`/v1/users/${victimId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", await etagOf(`/v1/users/${victimId}`, userToken));

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(prisma._users.has(victimId)).toBe(true);
    });

    it("negative control: with the role guard stubbed out, the non-admin gets the admin list", async () => {
      jest.spyOn(RolesGuard.prototype, "canActivate").mockReturnValue(true);

      const response = await http().get("/v1/users").set("Authorization", `Bearer ${userToken}`);

      expect(response.status).toBe(HttpStatus.OK);
    });

    /**
     * The list of routes that answer an unauthenticated caller.
     *
     * Pinned, not derived: authentication being the default is only worth
     * something if opting out is visible. A new `@Public()` fails here, and the
     * fix is to add the route to this list in the same change that made it
     * public — which is exactly the sentence a reviewer needs to see.
     */
    const PUBLIC_ROUTES = [
      // No token can be presented for the endpoints that issue tokens.
      "POST /v1/auth/register",
      "POST /v1/auth/login",
      "POST /v1/auth/refresh",
      // Passport's redirect pair: the GoogleAuthGuard on these two is the
      // authentication, and it cannot run behind a bearer-token check.
      "GET /v1/auth/google",
      "GET /v1/auth/google/callback",
      // Probed by an orchestrator and scraped by Prometheus, neither of which
      // holds a credential. Both belong on the internal listener.
      "GET /v1/health",
      "GET /metrics",
      // The DI teaching endpoint, which reads nothing and discloses class names.
      // Delete `src/di-scopes` and this line goes with it.
      "GET /v1/di-scopes",
    ];

    /**
     * A stale entry is a standing exemption for whatever is mounted on that path
     * next, so the list has to be pruned as well as added to.
     */
    it("mitigated: every route the list names is still routed, so no exemption is stale", () => {
      const routed = new Set(listHttpRoutes(app).map(routeKey));

      expect([...PUBLIC_ROUTES].sort().filter((route) => !routed.has(route))).toEqual([]);
    });

    it("mitigated: each pinned route does answer without a token", async () => {
      const answered: { route: string; unauthorized: boolean }[] = [];
      // Sequentially: supertest binds the server itself on the first request
      // that finds it unbound and closes it again when that request ends, which
      // resets any sibling still in flight.
      for (const route of PUBLIC_ROUTES) {
        const [method, path] = route.split(" ") as [string, string];
        const response = await http()[method.toLowerCase() as "get"](path);
        answered.push({ route, unauthorized: response.status === HttpStatus.UNAUTHORIZED });
      }

      // Not "answers 200": a health check may report 503 and the OAuth redirect
      // answers 302. The claim is only that authentication is not what stopped
      // it, which is the half that would regress if a `@Public()` were dropped.
      expect(answered.filter(({ unauthorized }) => unauthorized)).toEqual([]);
    });

    it("mitigated: every other route answers an anonymous caller with 401", async () => {
      const guarded = listHttpRoutes(app).filter(
        (route) => !PUBLIC_ROUTES.includes(routeKey(route)),
      );
      const anonymous: { route: string; status: number }[] = [];
      // Sequentially, for the reason the spec above gives.
      for (const route of guarded) {
        // The path parameters are irrelevant: authentication is decided before
        // the handler, so any syntactically valid value reaches the guard.
        const path = route.path.replace(/:[^/]+/g, "probe");
        const response = await http()[route.method.toLowerCase() as "get"](path);
        anonymous.push({ route: routeKey(route), status: response.status });
      }

      expect(anonymous).not.toHaveLength(0);
      // Reported as the offending routes rather than as a count, so a failure
      // names what to look at.
      expect(anonymous.filter(({ status }) => status !== HttpStatus.UNAUTHORIZED)).toEqual([]);
    });
  });

  // ── API6:2023 — Unrestricted Access to Sensitive Business Flows ────────────
  //
  // Placing an order reserves stock, charges a card and books a carrier. The flow
  // that must not run twice is protected by `Idempotency-Key`: a retry replays
  // the first response rather than repeating the side effects. See
  // `docs/idempotency.md`.
  describe("API6:2023 Unrestricted Access to Sensitive Business Flows", () => {
    const basket = { items: [{ sku: "SKU-DESK-01", quantity: 1 }], shippingCountry: "GB" };

    const place = (key?: string) => {
      const call = http().post("/v1/orders").set("Authorization", `Bearer ${userToken}`);
      return (key === undefined ? call : call.set(IDEMPOTENCY_KEY_HEADER, key)).send(basket);
    };

    it("mitigated: a retried checkout under one key places one order", async () => {
      const first = await place("checkout-key-1");
      const retry = await place("checkout-key-1");

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(retry.status).toBe(HttpStatus.CREATED);
      expect(retry.body.data.id).toBe(first.body.data.id);
      expect(fixture.orders.all()).toHaveLength(1);
    });

    it("negative control: the same two requests without the key place two orders", async () => {
      const first = await place();
      const second = await place();

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(second.status).toBe(HttpStatus.CREATED);
      expect(second.body.data.id).not.toBe(first.body.data.id);
      expect(fixture.orders.all()).toHaveLength(2);
    });
  });

  // ── API7:2023 — Server Side Request Forgery ────────────────────────────────
  //
  // No endpoint in this application takes a URL and fetches it, which is the
  // strongest form of the mitigation: every outbound base URL comes from
  // validated configuration. What is left is the request input that reaches an
  // outbound *path* — a payment id — and the forgery available there is a call to
  // a different endpoint on the same upstream. `encodeURIComponent` is what
  // keeps an id an id.
  describe("API7:2023 Server Side Request Forgery", () => {
    const BASE_URL = "https://stripe.test";
    const SECRET_KEY = "sk_test_fake_key_for_unit_tests";
    /** A payment id that is a traversal and a query, not an id. */
    const HOSTILE_ID = "pi_1/../../refunds?tampered=1";

    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    /** Records where the client was pointed, and answers "no such payment". */
    function recordingUpstream(): string[] {
      const seen: string[] = [];
      global.fetch = jest.fn(async (input: unknown) => {
        seen.push(String(input));
        return new Response("{}", {
          status: HttpStatus.NOT_FOUND,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      return seen;
    }

    it("mitigated: a traversal in a payment id stays inside the path segment it was given", async () => {
      const seen = recordingUpstream();
      const provider = new StripePaymentProvider(
        stubConfig({ STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_API_BASE_URL: BASE_URL }),
        testHttpClient().client,
      );

      await expect(provider.find(HOSTILE_ID)).resolves.toBeNull();

      expect(seen).toHaveLength(1);
      const url = new URL(seen[0]!);
      expect(url.origin).toBe(BASE_URL);
      // The id is one segment, still: no `/v1/refunds`, and no parameter of the
      // caller's choosing on a request the application signs with its own key.
      expect(url.pathname).toBe(`/v1/payment_intents/${encodeURIComponent(HOSTILE_ID)}`);
      expect([...url.searchParams.keys()]).toEqual(["expand[]"]);
      expect(url.searchParams.has("tampered")).toBe(false);
    });

    /**
     * The same interpolation with the encoding taken out, which is the whole of
     * the difference. A read of a payment becomes a call on `/v1/refunds`,
     * carrying a query parameter the caller chose, signed with the
     * application's secret key.
     */
    it("negative control: without the encoding the same id reaches a different endpoint", () => {
      const forged = new URL(`${BASE_URL}/v1/payment_intents/${HOSTILE_ID}?expand[]=latest_charge`);

      // The traversal moved the call off the endpoint the method is named after.
      expect(forged.pathname).toBe("/v1/refunds");
      // And the `?` in the id started the query string, so the caller's
      // parameter is on a request the application signs with its own secret key
      // while the parameter the application meant to send is gone.
      expect(forged.searchParams.has("tampered")).toBe(true);
      expect(forged.searchParams.has("expand[]")).toBe(false);
    });
  });

  // ── API8:2023 — Security Misconfiguration ──────────────────────────────────
  //
  // Helmet and the CORS allowlist, bound by `applySecurity` before the router.
  // `test/security-headers.e2e-spec.ts` covers the policies themselves; what is
  // asserted here is that they are bound at all, and that it matters.
  describe("API8:2023 Security Misconfiguration", () => {
    it("mitigated: the response carries the hardening headers and no server fingerprint", async () => {
      const response = await http().get("/v1/health");

      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["strict-transport-security"]).toContain("max-age=");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });

    it("mitigated: an unhandled failure answers without disclosing what broke", async () => {
      // A handler that throws something that is not an `HttpException`: the
      // message is the kind of string that carries a connection URL in real life.
      jest.spyOn(UserAccessPolicy.prototype, "canAct").mockImplementation(() => {
        throw new Error("connect ECONNREFUSED db.internal:5432 while authenticating as api");
      });

      const response = await http()
        .get(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      // Neither the internal hostname nor what the process was doing when it
      // failed: both are reconnaissance, and a stack trace is a map.
      expect(JSON.stringify(response.body)).not.toContain("db.internal");
      expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
      expect(response.body.message).toBe("Internal server error");
      expect(response.body).not.toHaveProperty("stack");
    });

    /**
     * Headers are middleware, bound before `init()`, so they cannot be removed
     * from a running application — the control is a second one built without
     * `applySecurity`. Every other line of its construction is shared.
     */
    it("negative control: without applySecurity the same request carries none of them", async () => {
      const unhardened = await createTestApp({ security: "omitted" });
      try {
        const response = await request(unhardened.app.getHttpServer()).get("/v1/health");

        expect(response.headers["content-security-policy"]).toBeUndefined();
        expect(response.headers["strict-transport-security"]).toBeUndefined();
        expect(response.headers["x-content-type-options"]).toBeUndefined();
      } finally {
        await unhardened.app.close();
      }
    });
  });

  // ── API9:2023 — Improper Inventory Management ─────────────────────────────
  //
  // An endpoint nobody knows about is an endpoint nobody patches. The check is
  // `findInventoryViolations`, run against the routes the adapter will actually
  // match and the document the application publishes; its own teeth are
  // established in `src/common/swagger/route-inventory.spec.ts`, against tables
  // written to be wrong.
  describe("API9:2023 Improper Inventory Management", () => {
    const POLICY: InventoryPolicy = {
      // Passport's redirect pair carries `@ApiExcludeEndpoint()`: neither is
      // called by a client, and a "try it out" button on an OAuth redirect in
      // the docs page does nothing but confuse.
      undocumented: ["GET /v1/auth/google", "GET /v1/auth/google/callback"],
      // The scrape endpoint, `VERSION_NEUTRAL` because its client is pointed at
      // `/metrics` by default and the exposition's contract is the metric names.
      unversioned: ["GET /metrics"],
    };

    it("mitigated: every reachable route is published and versioned, or exempted on purpose", () => {
      const routes = listHttpRoutes(app);
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("inventory").setVersion("1.0").build(),
      );

      expect(routes.length).toBeGreaterThan(0);
      expect(findInventoryViolations(routes, documentedPathsOf(document), POLICY)).toEqual([]);
    });
  });

  // ── API10:2023 — Unsafe Consumption of APIs ────────────────────────────────
  //
  // What arrives from another service is not more trustworthy than what arrives
  // from a client. Every message read off the broker is checked against the schema
  // the registry holds for its event name before any subscriber sees it — see
  // `src/messaging/domain-event-codec.ts`.
  describe("API10:2023 Unsafe Consumption of APIs", () => {
    const contract = realEventContract();

    /** A message from a producer that shares the topic, built by hand. */
    function message(payload: unknown): IncomingMessage {
      return {
        topic: "domain-events",
        partition: 0,
        offset: "0",
        key: "user-1",
        value: Buffer.from(JSON.stringify(payload), "utf8"),
        headers: {
          [EVENT_HEADERS.name]: "user.registered",
          [EVENT_HEADERS.id]: "11111111-1111-4111-8111-111111111111",
          [EVENT_HEADERS.occurredAt]: "2026-08-27T00:00:00.000Z",
        },
        timestamp: new Date(),
      };
    }

    const valid = { userId: "user-1", email: "ada@example.test", name: "Ada", provider: null };

    it("mitigated: an upstream payload that breaks the contract never reaches a subscriber", () => {
      // Plainly one of ours by its headers, and wrong: `userId` is a number and
      // the address is not an address. A subscriber reading `.email` off this
      // would write it somewhere.
      const hostile = { ...valid, userId: 42, email: "not-an-email" };

      expect(() => decodeDomainEvent(message(hostile), contract)).toThrow(
        SchemaContractViolationError,
      );
    });

    it("negative control: the same message with a conforming payload decodes", () => {
      const decoded = decodeDomainEvent(message(valid), contract);

      // Which is what makes the rejection above the schema's doing: the headers,
      // the topic and the framing are identical in both, so nothing else could
      // have been what refused it.
      expect(decoded.name).toBe("user.registered");
      expect(decoded.payload).toEqual(valid);
    });
  });
});
