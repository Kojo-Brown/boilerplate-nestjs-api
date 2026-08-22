import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { UserPreferencesDto } from "./user-preferences.dto";

export class UserResponseDto {
  @ApiProperty({ example: "clxxxxxxxxxxxxxxxx" })
  readonly id!: string;

  @ApiProperty({ example: "jane@example.com" })
  readonly email!: string;

  @ApiPropertyOptional({ example: "Jane Doe", nullable: true })
  readonly name!: string | null;

  @ApiProperty({ enum: Role, example: Role.USER })
  readonly role!: Role;

  @ApiPropertyOptional({ example: "google", nullable: true })
  readonly provider!: string | null;

  @ApiPropertyOptional({ example: "avatars/user-1/1234567890.jpg", nullable: true })
  readonly avatarUrl!: string | null;

  @ApiPropertyOptional({ type: UserPreferencesDto, nullable: true })
  readonly preferences!: UserPreferencesDto | null;

  @ApiProperty({ example: "2024-01-01T00:00:00.000Z" })
  readonly createdAt!: Date;

  @ApiProperty({ example: "2024-01-01T00:00:00.000Z" })
  readonly updatedAt!: Date;

  @ApiProperty({
    example: 3,
    description:
      "Optimistic-concurrency version. Also returned as the `ETag` header, which is the form to send back in `If-Match`.",
  })
  readonly version!: number;
}
