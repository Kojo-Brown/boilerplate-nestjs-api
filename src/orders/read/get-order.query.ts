import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import { Role } from "@prisma/client";
import { SAGA_STORE, SagaRegistry, type SagaStore } from "@/saga";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { OrderNotFoundError } from "../orders.errors";
import { ORDER_STORE, type OrderStore } from "../ports";
import { toOrderView, type OrderView } from "./order-view";

/** One order, with how its checkout is going. */
export class GetOrderQuery extends Query<OrderView> {
  constructor(
    readonly id: string,
    readonly requester: Pick<AuthenticatedUser, "id" | "role">,
  ) {
    super();
  }
}

@QueryHandler(GetOrderQuery)
export class GetOrderHandler implements IQueryHandler<GetOrderQuery> {
  constructor(
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(SAGA_STORE) private readonly sagas: SagaStore,
    private readonly registry: SagaRegistry,
  ) {}

  /**
   * Ownership is checked here rather than in the controller, for the reason the
   * users module gives: who may see an order is part of what the operation
   * means, not part of how the request arrived.
   *
   * Somebody else's order is a 404 and not a 403. A 403 confirms that the id
   * exists, which turns the endpoint into an oracle for guessing order ids —
   * and unlike `/users/:id`, where the caller often already knows the account
   * is there, nothing about an order id is public.
   */
  async execute({ id, requester }: GetOrderQuery): Promise<OrderView> {
    const order = await this.orders.find(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.userId !== requester.id && requester.role !== Role.ADMIN) {
      throw new OrderNotFoundError(id);
    }

    return toOrderView(order, await this.sagas.find(order.sagaId), this.registry);
  }
}
