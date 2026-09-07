export { INVENTORY_SERVICE } from "./inventory.port";
export type {
  InventoryService,
  ReserveStockInput,
  ReservedLine,
  StockReservation,
} from "./inventory.port";
export { SHIPPING_SERVICE } from "./shipping.port";
export type { CreateShipmentInput, Shipment, ShippingService } from "./shipping.port";
export { ORDER_STORE } from "./order-store.port";
export type { ListOrdersCriteria, OrderStore, OrderTransition } from "./order-store.port";
