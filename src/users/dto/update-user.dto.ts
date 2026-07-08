import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateUserDto {
  @ApiPropertyOptional({ example: "Jane Doe", maxLength: 100, description: "Display name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}
