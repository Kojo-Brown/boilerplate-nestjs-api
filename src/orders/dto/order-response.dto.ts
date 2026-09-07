import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { OrderView } from "../read/order-view";

export class OrderItemResponseDto {
  @ApiProperty({ example: "SKU-DESK-01" })
  readonly sku!: string;

  @ApiProperty({ example: 2 })
  readonly quantity!: number;

  @ApiProperty({ example: 34_900, description: "Unit price in minor units of the order currency." })
  readonly unitPriceMinor!: number;
}

export class OrderFulfilmentResponseDto {
  @ApiProperty({ example: "5a4f0c60-1f1a-4a3f-9f1e-8f2a0c9d1e2b" })
  readonly sagaId!: string;

  @ApiPropertyOptional({
    example: "COMPLETED",
    nullable: true,
    enum: ["RUNNING", "COMPENSATING", "COMPLETED", "COMPENSATED", "STUCK"],
    description:
      "Where the checkout saga got to. `COMPENSATED` means every completed step was undone; " +
      "`STUCK` means it could go neither forward nor back and a human has to look.",
  })
  readonly status!: string | null;

  @ApiPropertyOptional({
    example: "charge-payment",
    nullable: true,
    description: "The step it is at, or stopped at. Null once the saga has finished.",
  })
  readonly step!: string | null;

  @ApiPropertyOptional({ nullable: true, description: "The warehouse hold, once taken." })
  readonly reservationId!: string | null;

  @ApiPropertyOptional({ nullable: true, description: "The gateway's payment id, once charged." })
  readonly paymentId!: string | null;

  @ApiPropertyOptional({ nullable: true, description: "The carrier booking, once dispatched." })
  readonly shipmentId!: string | null;
}

/**
 * One order as the API returns it.
 *
 * `status` is the customer's view and `fulfilment.status` is the machinery's;
 * both are here because they answer different questions. A `CANCELLED` order
 * whose saga is `COMPENSATED` was cleanly unwound — the money is back and the
 * stock is on the shelf. A `PROCESSING` order whose saga is `STUCK` is the one
 * anybody needs to know about.
 */
export class OrderResponseDto {
  @ApiProperty({ example: "5a4f0c60-1f1a-4a3f-9f1e-8f2a0c9d1e2b" })
  readonly id!: string;

  @ApiProperty({ enum: ["PENDING", "PROCESSING", "CONFIRMED", "CANCELLED"] })
  readonly status!: string;

  @ApiProperty({ type: [OrderItemResponseDto] })
  readonly items!: OrderItemResponseDto[];

  @ApiProperty({ example: 88_150, description: "Order total in minor units." })
  readonly totalMinor!: number;

  @ApiProperty({ example: "GBP" })
  readonly currency!: string;

  @ApiProperty({ example: "GB" })
  readonly shippingCountry!: string;

  @ApiPropertyOptional({
    example: 'No carrier serves "AQ"',
    nullable: true,
    description: "Why the order was cancelled, in the words of the step that failed.",
  })
  readonly failureReason!: string | null;

  @ApiProperty({ type: OrderFulfilmentResponseDto })
  readonly fulfilment!: OrderFulfilmentResponseDto;

  @ApiProperty({ example: "2026-09-07T09:30:00.000Z" })
  readonly createdAt!: Date;

  @ApiProperty({ example: "2026-09-07T09:30:02.000Z" })
  readonly updatedAt!: Date;
}

/**
 * Shapes a view for the wire.
 *
 * Hand-written rather than a `class-transformer` pass, for the reason every
 * response DTO in this repository is: what leaves the process is decided by a
 * list somebody wrote, not by which fields happen to be on an object. The
 * `sagaId` is exposed on purpose — it is what a support conversation is about —
 * while the saga's `state`, `log` and `lastError` are not, since the log names
 * internal steps and the state carries a gateway's ids.
 */
export function toOrderResponse(view: OrderView): OrderResponseDto {
  const { order, fulfilment } = view;
  return {
    id: order.id,
    status: order.status,
    items: order.items.map((item) => ({ ...item })),
    totalMinor: order.total.amountMinor,
    currency: order.total.currency,
    shippingCountry: order.shippingCountry,
    failureReason: order.failureReason,
    fulfilment: { ...fulfilment },
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
