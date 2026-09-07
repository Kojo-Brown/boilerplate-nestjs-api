import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import { SAGA_STORE, SagaRegistry, type SagaStore } from "@/saga";
import { ORDER_STORE, type OrderStore } from "../ports";
import type { ListOrdersQueryDto } from "../dto/list-orders-query.dto";
import { toOrderView, type OrderView } from "./order-view";

/** A page of the caller's own orders, newest first. */
export class ListOrdersQuery extends Query<CursorPage<OrderView>> {
  constructor(
    readonly userId: string,
    readonly criteria: ListOrdersQueryDto,
  ) {
    super();
  }
}

@QueryHandler(ListOrdersQuery)
export class ListOrdersHandler implements IQueryHandler<ListOrdersQuery> {
  constructor(
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(SAGA_STORE) private readonly sagas: SagaStore,
    private readonly registry: SagaRegistry,
  ) {}

  /**
   * Always the caller's own orders — there is no `userId` parameter to get
   * wrong, which is the cheapest way to make a listing endpoint safe.
   *
   * The saga is fetched per order rather than in one query, and that is a real
   * N+1 that a page of twenty makes twenty-one round trips. It is left as one
   * deliberately: `SagaStore` has no batch read, adding one for a page of
   * twenty would be inventing an interface for a number that does not hurt yet,
   * and the alternative — denormalising the fulfilment onto the order row — is
   * the duplication `toOrderView` exists to avoid. `docs/saga.md` says what to
   * do when a page of orders is a hot path.
   */
  async execute({ userId, criteria }: ListOrdersQuery): Promise<CursorPage<OrderView>> {
    const rows = await this.orders.listForUser({
      userId,
      limit: criteria.limit,
      ...(criteria.cursor ? { cursor: decodeCursor(criteria.cursor) } : {}),
    });

    const views = await Promise.all(
      rows.map(async (order) =>
        toOrderView(order, await this.sagas.find(order.sagaId), this.registry),
      ),
    );

    return buildCursorPage(views, criteria.limit, (view) => view.order.id);
  }
}
