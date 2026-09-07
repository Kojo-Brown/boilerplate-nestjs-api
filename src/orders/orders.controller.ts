import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import { CursorPageOf } from "@/common/pagination";
import { ApiCommonErrors, ApiNotFound } from "@/common/swagger/api-error-responses.decorator";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ListOrdersQueryDto } from "./dto/list-orders-query.dto";
import { OrderResponseDto, toOrderResponse } from "./dto/order-response.dto";
import { GetOrderQuery, ListOrdersQuery } from "./read";
import { PlaceOrderCommand } from "./write";

/**
 * HTTP for orders, and nothing else.
 *
 * The interesting decision here is what the checkout endpoint answers with. A
 * failed checkout is **201 with a cancelled order**, not a 4xx: the order row
 * exists either way, it is addressable at `GET /v1/orders/{id}`, and it carries
 * the reason it did not go through. Answering with an error would be claiming
 * that nothing was created, which is untrue and would leave a customer with a
 * record they cannot fetch and a support agent with nothing to look at.
 *
 * A checkout that is still running answers 201 as well, with
 * `fulfilment.status` of `RUNNING` — the saga is durable, `SagaRecoveryService`
 * will finish it, and the client polls the order or watches its events on the
 * SSE stream. The only 4xx from `POST` is a request that was never an order:
 * an unknown SKU, an invalid country, no items.
 */
@ApiTags("orders")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class OrdersController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Place an order",
    description:
      "Prices the basket from the catalogue, writes the order and its checkout saga in one " +
      "transaction, then runs the saga as far as it will go. Returns the order as it stands: " +
      "`CONFIRMED` when the whole flow succeeded, `CANCELLED` when a step failed and " +
      "everything before it was compensated, `PROCESSING` when a step asked to be retried " +
      "later and the recovery poller has it. Send an `Idempotency-Key` header to make a " +
      "retried checkout safe — see docs/idempotency.md.",
  })
  @ApiCreatedResponse({ type: ApiEnvelopeOf(OrderResponseDto) })
  @ApiCommonErrors()
  async place(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthenticatedUser) {
    const order = await this.commands.execute(
      new PlaceOrderCommand(user.id, {
        lines: dto.items.map((item) => ({ sku: item.sku, quantity: item.quantity })),
        shippingCountry: dto.shippingCountry,
      }),
    );
    // Re-read through the query side rather than shaping the command's return
    // value: the response carries the saga's progress, and the command answers
    // with the order row alone.
    return toOrderResponse(await this.queries.execute(new GetOrderQuery(order.id, user)));
  }

  @Get()
  @ApiOperation({
    summary: "List my orders",
    description: "Cursor-paginated, newest first. Always the caller's own orders.",
  })
  @ApiOkResponse({ type: CursorPageOf(OrderResponseDto) })
  @ApiCommonErrors()
  async list(@Query() query: ListOrdersQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const page = await this.queries.execute(new ListOrdersQuery(user.id, query));
    return { ...page, items: page.items.map(toOrderResponse) };
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get an order",
    description:
      "Returns the order and how its checkout is going. Somebody else's order answers 404 " +
      "rather than 403, so an id cannot be used to discover which orders exist.",
  })
  @ApiParam({
    name: "id",
    description: "Order id",
    example: "5a4f0c60-1f1a-4a3f-9f1e-8f2a0c9d1e2b",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(OrderResponseDto) })
  @ApiNotFound("Order")
  @ApiCommonErrors()
  async findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return toOrderResponse(await this.queries.execute(new GetOrderQuery(id, user)));
  }
}
