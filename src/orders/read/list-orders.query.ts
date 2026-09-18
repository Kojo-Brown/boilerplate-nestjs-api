import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import { SagaLoaders, SagaRegistry } from "@/saga";
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
    private readonly loaders: SagaLoaders,
    private readonly registry: SagaRegistry,
  ) {}

  /**
   * Always the caller's own orders — there is no `userId` parameter to get
   * wrong, which is the cheapest way to make a listing endpoint safe.
   *
   * Two round trips for any page size: the orders, then every saga they name.
   * It used to be one per order — a page of twenty cost twenty-one — and the
   * shape of the code below is deliberately the same as it was then. The
   * `await` inside the `map` is what makes that possible: each `load` is queued
   * in this tick and the loader turns the whole page into a single `findMany`,
   * so the composition stays per-order while the reads do not. The alternative,
   * collecting ids and zipping the results back, is the same query count
   * written so that a second relation cannot be read alongside the first.
   *
   * The loader is created here rather than injected because its cache must not
   * outlive this call: these are one customer's orders, and a loader that lived
   * longer would answer the next caller with them. `SagaLoaders` says more.
   *
   * `test/orders-read.db-spec.ts` counts the statements against a real server,
   * so a regression to the per-order read fails a spec instead of a dashboard.
   */
  async execute({ userId, criteria }: ListOrdersQuery): Promise<CursorPage<OrderView>> {
    const rows = await this.orders.listForUser({
      userId,
      limit: criteria.limit,
      ...(criteria.cursor ? { cursor: decodeCursor(criteria.cursor) } : {}),
    });

    const sagas = this.loaders.byId();
    const views = await Promise.all(
      rows.map(async (order) => toOrderView(order, await sagas.load(order.sagaId), this.registry)),
    );

    return buildCursorPage(views, criteria.limit, (view) => view.order.id);
  }
}
