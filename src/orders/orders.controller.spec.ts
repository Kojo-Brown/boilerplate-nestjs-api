import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { OrdersController } from "./orders.controller";
import { GetOrderQuery, ListOrdersQuery } from "./read";
import type { OrderView } from "./read";
import { PlaceOrderCommand } from "./write";

const user: AuthenticatedUser = { id: "user-1", email: "buyer@example.test", role: "USER" };

const view: OrderView = {
  order: {
    id: "order-1",
    userId: user.id,
    items: [{ sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 }],
    total: { amountMinor: 69_800, currency: "GBP" },
    shippingCountry: "GB",
    status: "CONFIRMED",
    failureReason: null,
    sagaId: "saga-1",
    createdAt: new Date("2026-09-07T09:30:00.000Z"),
    updatedAt: new Date("2026-09-07T09:30:02.000Z"),
  },
  fulfilment: {
    sagaId: "saga-1",
    status: "COMPLETED",
    step: null,
    reservationId: "saga-1:reserve-stock",
    paymentId: "pay_mock_000001",
    shipmentId: "saga-1:create-shipment",
  },
};

const commands = { execute: jest.fn() };
const queries = { execute: jest.fn() };

/**
 * What the controller is still responsible for once the handlers own the
 * decisions: the shape of the request it dispatches, and the shape of the
 * response it returns. There is nothing else left in it, which is the point.
 */
describe("OrdersController", () => {
  let controller: OrdersController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: CommandBus, useValue: commands },
        { provide: QueryBus, useValue: queries },
      ],
    }).compile();

    controller = module.get(OrdersController);
  });

  describe("POST /orders", () => {
    it("dispatches the caller's id and basket, never a price from the request", async () => {
      commands.execute.mockResolvedValue(view.order);
      queries.execute.mockResolvedValue(view);

      await controller.place(
        { items: [{ sku: "SKU-DESK-01", quantity: 2 }], shippingCountry: "GB" },
        user,
      );

      expect(commands.execute).toHaveBeenCalledWith(
        new PlaceOrderCommand(user.id, {
          lines: [{ sku: "SKU-DESK-01", quantity: 2 }],
          shippingCountry: "GB",
        }),
      );
    });

    it("answers with the order as the read side sees it, saga progress included", async () => {
      commands.execute.mockResolvedValue(view.order);
      queries.execute.mockResolvedValue(view);

      const response = await controller.place(
        { items: [{ sku: "SKU-DESK-01", quantity: 2 }], shippingCountry: "GB" },
        user,
      );

      expect(queries.execute).toHaveBeenCalledWith(new GetOrderQuery("order-1", user));
      expect(response).toEqual({
        id: "order-1",
        status: "CONFIRMED",
        items: [{ sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 }],
        totalMinor: 69_800,
        currency: "GBP",
        shippingCountry: "GB",
        failureReason: null,
        fulfilment: view.fulfilment,
        createdAt: view.order.createdAt,
        updatedAt: view.order.updatedAt,
      });
    });

    it("answers 201 with a cancelled order rather than an error when a step failed", async () => {
      // The order exists either way and is addressable; answering with an error
      // would claim nothing was created.
      const cancelled: OrderView = {
        order: { ...view.order, status: "CANCELLED", failureReason: 'No carrier serves "AQ"' },
        fulfilment: { ...view.fulfilment, status: "COMPENSATED" },
      };
      commands.execute.mockResolvedValue(cancelled.order);
      queries.execute.mockResolvedValue(cancelled);

      const response = await controller.place(
        { items: [{ sku: "SKU-DESK-01", quantity: 2 }], shippingCountry: "AQ" },
        user,
      );

      expect(response.status).toBe("CANCELLED");
      expect(response.failureReason).toBe('No carrier serves "AQ"');
    });
  });

  describe("GET /orders", () => {
    it("lists the caller's own orders and shapes every item", async () => {
      queries.execute.mockResolvedValue({ items: [view], nextCursor: null, hasNextPage: false });

      const page = await controller.list({ limit: 20 }, user);

      expect(queries.execute).toHaveBeenCalledWith(new ListOrdersQuery(user.id, { limit: 20 }));
      expect(page.items).toEqual([expect.objectContaining({ id: "order-1", totalMinor: 69_800 })]);
      expect(page.hasNextPage).toBe(false);
    });
  });

  describe("GET /orders/:id", () => {
    it("passes the requester through, because ownership is the handler's decision", async () => {
      queries.execute.mockResolvedValue(view);

      await controller.findOne("order-1", user);

      expect(queries.execute).toHaveBeenCalledWith(new GetOrderQuery("order-1", user));
    });
  });
});
