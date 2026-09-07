import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import { SEED_STOCK } from "@/orders";
import { SagaOrchestrator } from "@/saga";

/**
 * The checkout, end to end, through HTTP.
 *
 * Every participant here is the one the application binds — the warehouse, the
 * carrier and the mock gateway all run their real state machines — so what these
 * specs exercise is the whole path from a request to a refund. The two
 * substitutions are the stores (`InMemorySagaStore`, `InMemoryOrderStore`),
 * because `InMemoryPrismaService` has no delegate for either table, and both are
 * held to the same behavioural contract as the Prisma adapters.
 */
describe("Orders (e2e)", () => {
  let app: INestApplication;
  let fixture: TestApp;
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    fixture = await createTestApp();
    app = fixture.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    fixture.prisma.reset();
    fixture.outbox.reset();
    fixture.sagas.reset();
    fixture.orders.reset();
    // The warehouse and the carrier are process-scoped and shared by every spec
    // in this file, so a checkout in one would otherwise be the starting stock
    // of the next.
    fixture.inventory.reset();
    fixture.shipping.reset();

    token = await register("buyer@example.com");
    otherToken = await register("someone-else@example.com");
  });

  async function register(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post("/v1/auth/register")
      .send({ email, password: process.env["E2E_TEST_PASSWORD"]!, name: "Buyer" });
    return response.body.data.accessToken as string;
  }

  const place = (body: object, as = token) =>
    request(app.getHttpServer()).post("/v1/orders").set("Authorization", `Bearer ${as}`).send(body);

  const basket = (sku = "SKU-DESK-01", quantity = 2, shippingCountry = "GB") => ({
    items: [{ sku, quantity }],
    shippingCountry,
  });

  /**
   * The order events the outbox has been asked to carry, in order.
   *
   * Filtered to `order.*` because registering the two accounts in `beforeEach`
   * stages a `user.registered` apiece — real traffic this suite is not about,
   * and an assertion that listed them would break every time registration
   * announced something new.
   */
  const staged = () =>
    fixture.outbox
      .all()
      .map((row) => row.name)
      .filter((name) => name.startsWith("order."));

  describe("a checkout that goes through", () => {
    it("answers 201 with a confirmed order, priced from the catalogue", async () => {
      const response = await place(basket());

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(
        expect.objectContaining({
          status: "CONFIRMED",
          totalMinor: 69_800,
          currency: "GBP",
          shippingCountry: "GB",
        }),
      );
      expect(response.body.data.items).toEqual([
        { sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 },
      ]);
    });

    it("reports the finished saga alongside the order", async () => {
      const response = await place(basket());

      expect(response.body.data.fulfilment).toEqual(
        expect.objectContaining({
          status: "COMPLETED",
          // A finished saga is not *at* a step.
          step: null,
          paymentId: expect.stringMatching(/^pay_mock_/),
        }),
      );
    });

    it("takes the stock and books exactly one parcel", async () => {
      await place(basket());

      expect(fixture.inventory.stockOf("SKU-DESK-01")).toBe(SEED_STOCK["SKU-DESK-01"]! - 2);
      expect(fixture.shipping.booked).toHaveLength(1);
    });

    it("announces the order placed and confirmed, and delivers both once drained", async () => {
      await place(basket());

      expect(staged()).toEqual(["order.placed", "order.confirmed"]);
      const report = await fixture.drainOutbox();
      expect(report.outcomes.every((outcome) => outcome.disposition === "published")).toBe(true);
    });
  });

  describe("a checkout that has to be unwound", () => {
    it("answers 201 with a cancelled order when no carrier serves the destination", async () => {
      const response = await place(basket("SKU-DESK-01", 1, "AQ"));

      // 201 rather than a 4xx: the order row exists, is addressable, and
      // carries the reason. An error response would claim nothing was created.
      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe("CANCELLED");
      expect(response.body.data.failureReason).toBe('No carrier serves "AQ"');
      expect(response.body.data.fulfilment.status).toBe("COMPENSATED");
    });

    it("gives the stock back and refunds the money", async () => {
      await place(basket("SKU-CHAIR-02", 3, "AQ"));

      expect(fixture.inventory.stockOf("SKU-CHAIR-02")).toBe(SEED_STOCK["SKU-CHAIR-02"]);
      expect(fixture.shipping.booked).toHaveLength(0);

      const instance = fixture.sagas.all()[0];
      const paymentId = (instance?.state as { paymentId?: string }).paymentId ?? "";
      expect(paymentId).toMatch(/^pay_mock_/);
    });

    it("announces the cancellation instead of a confirmation", async () => {
      await place(basket("SKU-DESK-01", 1, "AQ"));
      expect(staged()).toEqual(["order.placed", "order.cancelled"]);
    });

    it("cancels without charging anybody when the item is out of stock", async () => {
      const response = await place(basket("SKU-SOLD-OUT", 1));

      expect(response.body.data.status).toBe("CANCELLED");
      expect(response.body.data.failureReason).toMatch(/Only 0 of "SKU-SOLD-OUT" available/);
      expect(response.body.data.fulfilment.paymentId).toBeNull();
    });
  });

  describe("reading orders back", () => {
    it("serves the order and its fulfilment to its owner", async () => {
      const placed = await place(basket());
      const id = placed.body.data.id as string;

      const response = await request(app.getHttpServer())
        .get(`/v1/orders/${id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(id);
      expect(response.body.data.fulfilment.sagaId).toEqual(expect.any(String));
    });

    it("answers 404 for somebody else's order rather than 403", async () => {
      const placed = await place(basket());

      const response = await request(app.getHttpServer())
        .get(`/v1/orders/${placed.body.data.id}`)
        .set("Authorization", `Bearer ${otherToken}`);

      expect(response.status).toBe(404);
    });

    it("lists only the caller's own orders, newest first", async () => {
      await place(basket("SKU-DESK-01", 1));
      await place(basket("SKU-LAMP-03", 1));
      await place(basket("SKU-CHAIR-02", 1), otherToken);

      const response = await request(app.getHttpServer())
        .get("/v1/orders?limit=10")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      const skus = response.body.data.items.map(
        (order: { items: { sku: string }[] }) => order.items[0]?.sku,
      );
      expect(skus).toEqual(["SKU-LAMP-03", "SKU-DESK-01"]);
    });

    it("pages with an opaque cursor", async () => {
      await place(basket("SKU-DESK-01", 1));
      await place(basket("SKU-LAMP-03", 1));

      const first = await request(app.getHttpServer())
        .get("/v1/orders?limit=1")
        .set("Authorization", `Bearer ${token}`);
      expect(first.body.data.hasNextPage).toBe(true);

      const second = await request(app.getHttpServer())
        .get(`/v1/orders?limit=1&cursor=${first.body.data.nextCursor}`)
        .set("Authorization", `Bearer ${token}`);

      expect(second.body.data.items[0].id).not.toBe(first.body.data.items[0].id);
      expect(second.body.data.hasNextPage).toBe(false);
    });
  });

  describe("requests that were never an order", () => {
    it("refuses an unknown SKU with a 400, before anything is written", async () => {
      const response = await place(basket("SKU-IMAGINARY", 1));

      expect(response.status).toBe(400);
      expect(fixture.orders.all()).toHaveLength(0);
      expect(fixture.sagas.all()).toHaveLength(0);
    });

    it.each([
      ["no items", { items: [], shippingCountry: "GB" }],
      [
        "a country that is not one",
        { items: [{ sku: "SKU-DESK-01", quantity: 1 }], shippingCountry: "Britain" },
      ],
      [
        "a quantity of zero",
        { items: [{ sku: "SKU-DESK-01", quantity: 0 }], shippingCountry: "GB" },
      ],
      [
        "a price the client made up",
        {
          items: [{ sku: "SKU-DESK-01", quantity: 1, unitPriceMinor: 1 }],
          shippingCountry: "GB",
        },
      ],
    ])("refuses %s", async (_case, body) => {
      // The last one matters most: `forbidNonWhitelisted` is what stops a
      // request naming its own price, and the catalogue is what decides it
      // regardless.
      expect((await place(body)).status).toBe(400);
    });

    it("refuses an unauthenticated checkout", async () => {
      const response = await request(app.getHttpServer()).post("/v1/orders").send(basket());
      expect(response.status).toBe(401);
    });
  });

  describe("recovery", () => {
    it("finishes a checkout the request never got to advance", async () => {
      // The crash this whole mechanism exists for: the order and its instance
      // committed, and the process died before the advance. Nothing else in the
      // system would ever move it.
      const advance = jest
        .spyOn(fixture.app.get(SagaOrchestrator), "advance")
        .mockRejectedValueOnce(new Error("the replica went away"));

      const placed = await place(basket());
      expect(placed.body.data.status).toBe("PENDING");
      expect(placed.body.data.fulfilment.status).toBe("RUNNING");

      advance.mockRestore();
      const report = await fixture.recoverSagas();
      expect(report.claimed).toBe(1);

      const response = await request(app.getHttpServer())
        .get(`/v1/orders/${placed.body.data.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(response.body.data.status).toBe("CONFIRMED");
    });
  });
});
