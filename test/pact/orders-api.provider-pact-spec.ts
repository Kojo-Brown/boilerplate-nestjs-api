import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import { Verifier } from "@pact-foundation/pact";
import request from "supertest";
import { createTestApp, type TestApp } from "../helpers/create-test-app";

/**
 * Provider-side verification: this API, replayed against every interaction the
 * `web-storefront` pact records.
 *
 * What this adds over `test/orders.e2e-spec.ts`, which already drives the same
 * endpoints over HTTP: the e2e suite asserts what *this* team decided the
 * response should look like, and will happily stay green through a change no
 * consumer survives. Renaming `totalMinor`, dropping `meta.version`, answering
 * 403 instead of 404 on somebody else's order — each is one line in an e2e
 * expectation and a broken storefront. The pact is the other side's requirements
 * expressed in a form this build can fail on, which is the only mechanism that
 * puts a consumer's needs in front of a provider's reviewer.
 *
 * Three decisions worth stating.
 *
 * **The real application, on a real socket.** `createTestApp` is the same
 * fixture every e2e suite uses — every guard, pipe, interceptor and filter bound
 * exactly as `main.ts` binds them — and it is `listen`ed on an ephemeral port
 * rather than driven through supertest, because the Pact verifier is a Rust
 * process that speaks HTTP to a URL. The substitutions are the stores, for the
 * reasons `create-test-app.ts` documents; nothing about the wire format is faked,
 * which is what a contract is about.
 *
 * **States are set up through the application's own endpoints.** A handler that
 * reached into `InMemoryOrderStore` and planted a row would be verifying the
 * response shape of an order no checkout ever produced. So "the customer has one
 * confirmed order" registers a customer and runs a real checkout, and hands the
 * verifier the id it got back — see `fromProviderState` in the consumer spec,
 * which is what lets the pact name an id the provider chooses.
 *
 * **The bearer token is minted here, not recorded in the pact.** The pact carries
 * `Bearer mock-access-token`; `requestFilter` below swaps in a token this process
 * minted seconds ago by registering a user. Two reasons, and neither is
 * convenience: a real token in a pact file is a credential in a repository, and
 * it would be expired by the time anybody verified it. The guard chain is **not**
 * bypassed — the token is genuine, `JwtStrategy` verifies its signature,
 * `TenantGuard` checks its `tid`, and the orders it can see are the ones the
 * access policy says it can.
 */

const PACT_FILE = path.resolve(__dirname, "../../pacts/web-storefront-orders-api.json");

/**
 * The routes pact-js's own verification proxy serves, as opposed to the ones it
 * forwards to this API. `requestFilter` below has to leave them alone.
 *
 * Hard-coded because pact-js does not export them (`verifier.js` declares
 * `/_pactSetup` and `/_messages` as class fields). If a future version renames
 * one, the filter stamps a stray `Authorization` header on a request pact sends
 * to itself, which pact ignores — the failure mode is harmless rather than
 * mysterious, which is why this is a list of strings and not a regex.
 */
const PACT_PROXY_PATHS = new Set(["/_pactSetup", "/_messages"]);

/**
 * The access token for the customer the current provider state set up.
 *
 * Module-scoped because the verifier runs state setup and the request it belongs
 * to as two separate calls into this process, and `requestFilter` has no way to
 * ask which state it is serving. Written by every state handler and read by the
 * filter, so an interaction can never be served with the previous state's
 * identity — and `undefined` between them, which the filter refuses loudly
 * rather than sending an anonymous request that would fail as a 401 mismatch
 * nobody could explain.
 */
let currentAccessToken: string | undefined;

describe("orders-api (provider pact verification)", () => {
  let fixture: TestApp;
  let baseUrl: string;
  /** Restored in `afterAll`; see `silenceLoopbackProxy`. */
  let restoreProxyEnv: () => void;

  beforeAll(async () => {
    fixture = await createTestApp();
    // `createTestApp` only `init()`s the application. The verifier needs a port.
    await fixture.app.listen(0);
    const address = fixture.app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    restoreProxyEnv = silenceLoopbackProxy();
  });

  afterAll(async () => {
    restoreProxyEnv();
    await fixture.app.close();
  });

  it("satisfies every interaction in the web-storefront pact", async () => {
    const output = await new Verifier({
      provider: "orders-api",
      providerBaseUrl: baseUrl,
      // A file rather than a broker URL. docs/pact.md covers the swap: it is
      // `pactBrokerUrl` plus `publishVerificationResult` here, and nothing in the
      // state handlers below changes.
      pactUrls: [PACT_FILE],
      // Recorded against the pact so a `can-i-deploy` check has something to read
      // once a broker exists. Harmless without one.
      providerVersion: process.env["GITHUB_SHA"] ?? "local",
      providerVersionBranch: process.env["GITHUB_REF_NAME"] ?? "local",
      stateHandlers: {
        /**
         * Returns the id of the order it created, which the verifier substitutes
         * into the request path. The checkout is the real one — priced from the
         * catalogue, saga run to completion — so the response the pact is matched
         * against is a response this application actually produces.
         */
        "the customer has one confirmed order": async () => {
          const token = await freshCustomer("pact-buyer");
          const placed = await http()
            .post("/v1/orders")
            .set("Authorization", `Bearer ${token}`)
            .send({ items: [{ sku: "SKU-DESK-01", quantity: 2 }], shippingCountry: "GB" });

          // A state handler that quietly failed would hand the verifier a 404 and
          // report it as a contract mismatch, which is the least useful place to
          // find out that the setup broke.
          expect(placed.status).toBe(201);
          expect(placed.body.data.status).toBe("CONFIRMED");

          return { orderId: placed.body.data.id as string };
        },

        /**
         * A customer who has just registered. Serves both the empty-history
         * interaction and the unknown-order 404 — in the second, "no orders"
         * is precisely what makes the id unknown *and* what makes 404 the honest
         * answer rather than a 403 that would confirm the order exists.
         */
        "the customer has no orders": async () => {
          await freshCustomer("pact-newcomer");
        },

        /**
         * The warehouse, back to its seeded shelves. `InMemoryInventoryService` is
         * process-scoped and shared with the state above, so without this a
         * checkout here would be reserving against whatever stock the last
         * interaction left behind.
         */
        "the catalogue stocks SKU-DESK-01": async () => {
          await freshCustomer("pact-shopper");
        },
      },
      /**
       * Swaps the pact's placeholder bearer for the token the state handler
       * minted. Pact runs this in a proxy in front of the provider, so what the
       * application receives is an ordinary request with an ordinary
       * `Authorization` header — nothing in the guard chain is skipped or stubbed.
       *
       * The early return is load-bearing, and not obvious from the API: pact-js
       * registers this filter with `app.use`, which puts it ahead of the proxy's
       * *own* routes, so it also sees the state-setup call the verifier makes
       * before each interaction. Treating that call like an interaction is how
       * this spec first failed — the filter refused it for having no token yet,
       * the setup request never reached its handler, and all four interactions
       * were reported as "one or more of the setup state change handlers has
       * failed" thirty seconds apart, which says nothing about the cause.
       */
      requestFilter: (req: Request, _res, next) => {
        if (PACT_PROXY_PATHS.has(req.path)) {
          next();
          return;
        }

        if (currentAccessToken === undefined) {
          // `next(error)` rather than `throw`: this is the documented way to
          // reject from Express middleware, and it produces a 500 the verifier
          // reports against the interaction instead of a socket it hangs on.
          next(
            new Error(
              "No access token for this interaction — no provider state handler ran for it. " +
                "Every interaction in this pact is authenticated; see the state handlers above.",
            ),
          );
          return;
        }

        req.headers.authorization = `Bearer ${currentAccessToken}`;
        next();
      },
      logLevel: "warn",
    }).verifyProvider();

    // `verifyProvider` rejects on a mismatch, so reaching this line is the pass.
    // Asserted anyway so the spec fails rather than passes vacuously if a future
    // version of pact-js ever resolves on failure.
    expect(output).toBeDefined();
  });

  /** Registers a new customer and remembers their token for `requestFilter`. */
  async function freshCustomer(handle: string): Promise<string> {
    resetProviderState();

    const response = await http()
      .post("/v1/auth/register")
      .send({
        // Unique per call: registration refuses a duplicate email, and the
        // in-memory user table is reset above but the suite may add states later.
        email: `${handle}-${randomSuffix()}@example.com`,
        password: process.env["E2E_TEST_PASSWORD"],
        name: "Pact Customer",
      });

    expect(response.status).toBe(201);
    const token = response.body.data.accessToken as string;
    currentAccessToken = token;
    return token;
  }

  /**
   * Everything the application accumulates between interactions.
   *
   * The same list `test/orders.e2e-spec.ts` resets in `beforeEach`, and for the
   * same reason: the warehouse and the carrier are process-scoped, so one
   * interaction's checkout is the next one's starting stock. Without the orders
   * and sagas, "the customer has no orders" would be a state about a table that
   * still had the previous interaction's order in it.
   */
  function resetProviderState(): void {
    fixture.prisma.reset();
    fixture.outbox.reset();
    fixture.sagas.reset();
    fixture.orders.reset();
    fixture.inventory.reset();
    fixture.shipping.reset();
    fixture.emails.reset();
    currentAccessToken = undefined;
  }

  function http() {
    return request(fixture.app.getHttpServer());
  }
});

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Stops the Pact verifier from sending its loopback requests to an HTTP proxy.
 *
 * `pact-core`'s verifier is a Rust binary whose HTTP client reads `HTTPS_PROXY`
 * from the environment and applies it to the provider URL **without honouring
 * `NO_PROXY`** — so on any machine configured with a proxy (a corporate laptop,
 * a sandboxed CI container), verification fails with whatever that proxy says
 * about `127.0.0.1` rather than with anything about this API. The symptom is a
 * body mismatch quoting the proxy's own error page, which costs an afternoon to
 * recognise.
 *
 * Narrow on purpose: it clears the variables for the length of this spec only,
 * restores them afterwards, and is sound because the only host this spec talks to
 * is the provider on loopback. It is not a TLS or policy bypass — nothing here
 * makes an outbound request at all.
 */
function silenceLoopbackProxy(): () => void {
  const names = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ];
  const saved = new Map<string, string | undefined>();

  for (const name of names) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }

  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
