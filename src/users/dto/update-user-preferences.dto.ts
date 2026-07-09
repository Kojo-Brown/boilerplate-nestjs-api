import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateUserPreferencesDto {
  @ApiPropertyOptional({ enum: ["light", "dark", "system"], example: "dark" })
  @IsOptional()
  @IsIn(["light", "dark", "system"])
  theme?: "light" | "dark" | "system";

  @ApiPropertyOptional({ example: "fr", description: "BCP-47 language tag" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  pushNotifications?: boolean;

  @ApiPropertyOptional({ example: "America/New_York", description: "IANA timezone identifier" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;
}
