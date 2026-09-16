import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";

/** The maximum page `GET /v1/audit-log` will serve. */
export const AUDIT_LOG_MAX_PAGE = 200;

export class ListAuditLogQueryDto {
  /**
   * Exclusive cursor, as a string rather than a number.
   *
   * `@Type(() => Number)` on a 64-bit sequence is a rounding bug waiting for a
   * big enough table: `Number("9007199254740993")` is `9007199254740992`, and
   * the page after that cursor would silently repeat an entry. The string is
   * checked for digits here and parsed with `BigInt` in the controller, where a
   * value too large for the column is simply a page with nothing in it.
   */
  @ApiPropertyOptional({
    description: "Return entries after this chain position. Take it from the last entry's `seq`.",
    type: String,
    example: "42",
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: "afterSeq must be a non-negative integer" })
  readonly afterSeq?: string;

  @ApiPropertyOptional({
    description: `Number of entries to return (1–${AUDIT_LOG_MAX_PAGE})`,
    minimum: 1,
    maximum: AUDIT_LOG_MAX_PAGE,
    default: 50,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(AUDIT_LOG_MAX_PAGE)
  @Type(() => Number)
  readonly limit: number = 50;
}
