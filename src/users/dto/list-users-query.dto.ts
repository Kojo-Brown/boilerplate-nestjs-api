import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { CursorPaginationDto } from "@/common/pagination/cursor-pagination.dto";

export class ListUsersQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({ example: "jane", description: "Filter by name or email (case-insensitive)" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
