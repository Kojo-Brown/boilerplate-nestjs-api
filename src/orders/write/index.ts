import { PlaceOrderHandler } from "./place-order.command";

export { PlaceOrderCommand, PlaceOrderHandler } from "./place-order.command";
export type { PlaceOrderInput } from "./place-order.command";

/** Every command handler, for the module's providers list. */
export const ORDERS_COMMAND_HANDLERS = [PlaceOrderHandler];
