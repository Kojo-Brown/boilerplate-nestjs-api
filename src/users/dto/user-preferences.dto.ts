import { ApiProperty } from "@nestjs/swagger";

export class UserPreferencesDto {
  @ApiProperty({ enum: ["light", "dark", "system"], example: "system" })
  readonly theme!: "light" | "dark" | "system";

  @ApiProperty({ example: "en", description: "BCP-47 language tag" })
  readonly language!: string;

  @ApiProperty({ example: true })
  readonly emailNotifications!: boolean;

  @ApiProperty({ example: false })
  readonly smsNotifications!: boolean;

  @ApiProperty({ example: false })
  readonly pushNotifications!: boolean;

  @ApiProperty({ example: "UTC", description: "IANA timezone identifier" })
  readonly timezone!: string;
}
