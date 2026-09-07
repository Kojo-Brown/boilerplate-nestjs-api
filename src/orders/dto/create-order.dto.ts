import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsISO31661Alpha2,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * One line of a checkout request.
 *
 * There is deliberately no price here. An order's total is computed from
 * `PRODUCT_CATALOGUE`, because a request that carries its own prices is a
 * request that can name them — and a validator cannot tell a discount from a
 * fraud.
 */
export class CreateOrderItemDto {
  @ApiProperty({ example: "SKU-DESK-01", description: "Catalogue SKU." })
  @IsString()
  // The catalogue's own shape. Bounded and character-restricted because this
  // string is used as a map key and appears in log lines.
  @Matches(/^[A-Z0-9][A-Z0-9-]{2,31}$/, {
    message: "sku must be 3–32 upper-case letters, digits or hyphens",
  })
  readonly sku!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  // An upper bound per line as well as per order: without one, a single line of
  // 10^9 units is a reservation request no warehouse should be asked to price.
  @Max(100)
  readonly quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({ type: [CreateOrderItemDto], minItems: 1, maxItems: 20 })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  readonly items!: CreateOrderItemDto[];

  @ApiProperty({
    example: "GB",
    description:
      "ISO-3166 alpha-2 destination. A country no carrier serves is accepted here and " +
      "refused by the shipping step, which is what makes the order compensate.",
  })
  @IsISO31661Alpha2()
  readonly shippingCountry!: string;
}
