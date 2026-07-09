import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { UserPreferencesDto } from "./user-preferences.dto";

export class UserResponseDto {
  @ApiProperty({ example: "clxxxxxxxxxxxxxxxx" })
  id!: string;

  @ApiProperty({ example: "jane@example.com" })
  email!: string;

  @ApiPropertyOptional({ example: "Jane Doe", nullable: true })
  name!: string | null;

  @ApiProperty({ enum: Role, example: Role.USER })
  role!: Role;

  @ApiPropertyOptional({ example: "google", nullable: true })
  provider!: string | null;

  @ApiPropertyOptional({ example: "avatars/user-1/1234567890.jpg", nullable: true })
  avatarUrl!: string | null;

  @ApiPropertyOptional({ type: UserPreferencesDto, nullable: true })
  preferences!: UserPreferencesDto | null;

  @ApiProperty({ example: "2024-01-01T00:00:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ example: "2024-01-01T00:00:00.000Z" })
  updatedAt!: Date;
}
