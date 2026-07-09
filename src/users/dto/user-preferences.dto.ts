import { ApiProperty } from "@nestjs/swagger";

export class UserPreferencesDto {
  @ApiProperty({ enum: ["light", "dark", "system"], example: "system" })
  theme!: "light" | "dark" | "system";

  @ApiProperty({ example: "en", description: "BCP-47 language tag" })
  language!: string;

  @ApiProperty({ example: true })
  emailNotifications!: boolean;

  @ApiProperty({ example: false })
  pushNotifications!: boolean;

  @ApiProperty({ example: "UTC", description: "IANA timezone identifier" })
  timezone!: string;
}
