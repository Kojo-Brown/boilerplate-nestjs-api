import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateUserPreferencesDto {
  @ApiPropertyOptional({ enum: ["light", "dark", "system"], example: "dark" })
  @IsOptional()
  @IsIn(["light", "dark", "system"])
  readonly theme?: "light" | "dark" | "system";

  @ApiPropertyOptional({ example: "fr", description: "BCP-47 language tag" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  readonly language?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  readonly emailNotifications?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  readonly smsNotifications?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  readonly pushNotifications?: boolean;

  @ApiPropertyOptional({ example: "America/New_York", description: "IANA timezone identifier" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  readonly timezone?: string;
}
