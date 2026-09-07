import { GetOrderHandler } from "./get-order.query";
import { ListOrdersHandler } from "./list-orders.query";

export { GetOrderQuery, GetOrderHandler } from "./get-order.query";
export { ListOrdersQuery, ListOrdersHandler } from "./list-orders.query";
export { toOrderView } from "./order-view";
export type { OrderFulfilment, OrderView } from "./order-view";

/** Every query handler, for the module's providers list. */
export const ORDERS_QUERY_HANDLERS = [GetOrderHandler, ListOrdersHandler];
