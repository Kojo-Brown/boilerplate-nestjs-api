import path from "node:path";
import { MatchersV3, PactV4, SpecificationVersion } from "@pact-foundation/pact";
import { StorefrontApiError, StorefrontOrdersClient } from "./storefront-orders.client";

const { atLeastOneLike, fromProviderState, integer, regex, uuid } = MatchersV3;

/**
 * The `web-storefront` side of the contract, which exists to **write the pact**
 * that `orders-api.provider-pact-spec.ts` then verifies.
 *
 * It stands in for a suite in the consumer's repository — see the header of
 * `storefront-orders.client.ts` for why it is here at all, and docs/pact.md for
 * what moves where once a broker is in the picture. Every interaction below is
 * exercised through `StorefrontOrdersClient` rather than through `fetch`, so the
 * recorded request is one the consumer's own code produces: a pact written by
 * hand records what somebody believed the consumer sends, which is the one thing
 * a contract test is supposed to stop being a matter of belief.
 *
 * Two rules shape the expectations:
 *
 * **Matchers, not values, for anything the provider generates.** An order id, a
 * saga id and a timestamp are the provider's to choose; pinning the examples
 * would make the pact fail on the second run for a reason that has nothing to do
 * with the contract. The exceptions are the fields whose *values* the consumer
 * genuinely depends on — `success`, `meta.version`, the `error` code it switches
 * on, and `failureReason` being `null` on an order that did not fail.
 *
 * **Only the fields the storefront reads.** `reservationId`, `paymentId` and
 * `shipmentId` are in `OrderResponseDto` and deliberately absent here: Pact
 * matches the response as a subset, so a field nobody asked for stays free to
 * change. A contract test that asserted the whole DTO would be a snapshot test
 * with extra machinery, and it would turn every additive change to this API into
 * a broken consumer build.
 */

/** `Date#toISOString()`, which is what every timestamp this API emits is. */
const ISO_8601_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The statuses the storefront has a rendering for. A regex rather than a bare
 * string because this is the real expectation: the badge component switches on
 * these four, and a fifth arriving unannounced is a contract break the provider
 * should hear about from its own build.
 */
const ORDER_STATUS = /^(PENDING|PROCESSING|CONFIRMED|CANCELLED)$/;
const SAGA_STATUS = /^(RUNNING|COMPENSATING|COMPLETED|COMPENSATED|STUCK)$/;

/**
 * The token the *pact* carries, and never a credential.
 *
 * The provider replaces this with one it minted a moment earlier — see the
 * `requestFilter` in the provider spec — because a bearer token recorded into a
 * JSON file is expired by the time anybody verifies it and is a secret in a
 * repository until then. What the pact pins is the shape of the header, which is
 * the part that is actually a contract.
 */
const PLACEHOLDER_BEARER = "Bearer mock-access-token";

const jsonResponseHeaders = {
  /**
   * The charset is Express's; the contract is "it is JSON", so the charset is
   * optional and anything else is not.
   *
   * Anchored at both ends on purpose. A header regex is matched against the
   * **whole** value by the Pact matching core, not searched within it, so the
   * obvious `/^application\/json/` fails against `application/json;
   * charset=utf-8` — and reports it as `Expected 'application/json;
   * charset=utf-8' to match '^application/json'`, which reads like a bug in the
   * matcher rather than a missing `$`.
   */
  "Content-Type": regex(
    /^application\/json(;\s*charset=utf-8)?$/,
    "application/json; charset=utf-8",
  ),
};

/** The envelope every successful response is wrapped in. */
const envelopeMeta = {
  timestamp: regex(ISO_8601_UTC_MILLIS, "2026-09-07T09:30:02.000Z"),
  version: "v1",
};

/** One order, as the storefront reads it. */
const orderBody = {
  id: uuid("5a4f0c60-1f1a-4a3f-9f1e-8f2a0c9d1e2b"),
  status: regex(ORDER_STATUS, "CONFIRMED"),
  items: atLeastOneLike({
    sku: regex(/^SKU-[A-Z0-9-]+$/, "SKU-DESK-01"),
    quantity: integer(2),
    unitPriceMinor: integer(34_900),
  }),
  totalMinor: integer(69_800),
  currency: regex(/^[A-Z]{3}$/, "GBP"),
  shippingCountry: regex(/^[A-Z]{2}$/, "GB"),
  // Exact `null`, and that is the assertion: the storefront shows the cancellation
  // banner when this is set, so an order that went through must say so by being
  // null rather than by omitting the field.
  failureReason: null,
  fulfilment: {
    sagaId: uuid("265aa242-8246-4665-8e26-57cc6acd6390"),
    status: regex(SAGA_STATUS, "COMPLETED"),
    // Null once the saga has finished, which is the state this interaction is in.
    step: null,
  },
  createdAt: regex(ISO_8601_UTC_MILLIS, "2026-09-07T09:30:00.000Z"),
  updatedAt: regex(ISO_8601_UTC_MILLIS, "2026-09-07T09:30:02.000Z"),
};

const pact = new PactV4({
  consumer: "web-storefront",
  provider: "orders-api",
  // Committed, because without a broker this file is the only thing that carries
  // the contract from the consumer's build to the provider's. docs/pact.md.
  dir: path.resolve(__dirname, "../../pacts"),
  // V4 for `fromProviderState`: the order id in the path below is chosen by the
  // provider while it sets the state up, and V3 has no way to say so.
  spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
  logLevel: "warn",
});

describe("web-storefront → orders-api (consumer pact)", () => {
  const client = (baseUrl: string) =>
    new StorefrontOrdersClient({ baseUrl, accessToken: "mock-access-token" });

  it("reads one of the customer's own orders", async () => {
    await pact
      .addInteraction()
      .given("the customer has one confirmed order")
      .uponReceiving("a request for that order")
      .withRequest(
        "GET",
        // The id is the provider's: its state handler places a real order and
        // returns the id it got, and the verifier substitutes it here. The
        // example is what the consumer's own run used against the mock.
        fromProviderState(
          "/v1/orders/${orderId}",
          "/v1/orders/5a4f0c60-1f1a-4a3f-9f1e-8f2a0c9d1e2b",
        ),
        (builder) =>
          builder.headers({ Accept: "application/json", Authorization: PLACEHOLDER_BEARER }),
      )
      .willRespondWith(200, (builder) =>
        builder
          .headers(jsonResponseHeaders)
          .jsonBody({ success: true, data: orderBody, meta: envelopeMeta }),
      )
      .executeTest(async (mock) => {
        const order = await client(mock.url).getOrder("5a4f0c60-1f1a-4a3f-9f1e-8f2a0c9d1e2b");

        expect(order.status).toBe("CONFIRMED");
        expect(order.items).toHaveLength(1);
        expect(order.totalMinor).toBe(69_800);
        expect(order.failureReason).toBeNull();
        expect(order.fulfilment.status).toBe("COMPLETED");
      });
  });

  it("reads an empty order history", async () => {
    await pact
      .addInteraction()
      .given("the customer has no orders")
      .uponReceiving("a request for the first page of orders")
      .withRequest("GET", "/v1/orders", (builder) =>
        builder
          .query({ limit: "20" })
          .headers({ Accept: "application/json", Authorization: PLACEHOLDER_BEARER }),
      )
      .willRespondWith(200, (builder) =>
        builder.headers(jsonResponseHeaders).jsonBody({
          success: true,
          // An exact empty array, not `eachLike([])`: the assertion is that a
          // customer with no orders gets a page rather than a 404, and that the
          // cursor fields are present and terminal. `eachLike` would be matched
          // by any array at all, including one with somebody else's order in it.
          data: { items: [], nextCursor: null, hasNextPage: false },
          meta: envelopeMeta,
        }),
      )
      .executeTest(async (mock) => {
        const page = await client(mock.url).listOrders({ limit: 20 });

        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
        expect(page.hasNextPage).toBe(false);
      });
  });

  it("places an order", async () => {
    await pact
      .addInteraction()
      .given("the catalogue stocks SKU-DESK-01")
      .uponReceiving("a checkout for two standing desks")
      .withRequest("POST", "/v1/orders", (builder) =>
        builder
          .headers({
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: PLACEHOLDER_BEARER,
          })
          // Exact, both of them: what the consumer sends is the consumer's to
          // promise, and the provider's validation is entitled to refuse anything
          // else. A matcher here would say "some string will do", which is not
          // what the storefront does.
          .jsonBody({ items: [{ sku: "SKU-DESK-01", quantity: 2 }], shippingCountry: "GB" }),
      )
      .willRespondWith(201, (builder) =>
        builder
          .headers(jsonResponseHeaders)
          .jsonBody({ success: true, data: orderBody, meta: envelopeMeta }),
      )
      .executeTest(async (mock) => {
        const order = await client(mock.url).placeOrder({
          items: [{ sku: "SKU-DESK-01", quantity: 2 }],
          shippingCountry: "GB",
        });

        expect(order.status).toBe("CONFIRMED");
        expect(order.currency).toBe("GBP");
        expect(order.items[0]?.unitPriceMinor).toBe(34_900);
      });
  });

  it("is told that an order it cannot see does not exist", async () => {
    // The storefront's own routing can produce this: a bookmarked order id from
    // an account the customer has since signed out of. The interaction is in the
    // pact because the error *envelope* is a contract too — `StorefrontApiError`
    // reads `error` and `message` off this body, and this API answers 404 rather
    // than 403 on somebody else's order on purpose, so a 403 appearing here would
    // be both a behaviour change and a disclosure.
    const unknownId = "00000000-0000-4000-8000-000000000000";

    await pact
      .addInteraction()
      .given("the customer has no orders")
      .uponReceiving("a request for an order that does not exist")
      .withRequest("GET", `/v1/orders/${unknownId}`, (builder) =>
        builder.headers({ Accept: "application/json", Authorization: PLACEHOLDER_BEARER }),
      )
      .willRespondWith(404, (builder) =>
        builder.headers(jsonResponseHeaders).jsonBody({
          statusCode: 404,
          message: regex(/^Order .+ not found$/, `Order ${unknownId} not found`),
          error: "Not Found",
          timestamp: regex(ISO_8601_UTC_MILLIS, "2026-09-07T09:30:02.000Z"),
          path: regex(/^\/v1\/orders\/.+$/, `/v1/orders/${unknownId}`),
        }),
      )
      .executeTest(async (mock) => {
        const failure = await client(mock.url)
          .getOrder(unknownId)
          .then(
            () => undefined,
            (error: unknown) => error,
          );

        expect(failure).toBeInstanceOf(StorefrontApiError);
        expect((failure as StorefrontApiError).status).toBe(404);
        expect((failure as StorefrontApiError).code).toBe("Not Found");
      });
  });
});
