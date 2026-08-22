import { ApiProperty } from "@nestjs/swagger";

export class AuthenticatedUserDto {
  @ApiProperty({ example: "550e8400-e29b-41d4-a716-446655440000", description: "User UUID" })
  readonly id!: string;

  @ApiProperty({ example: "user@example.com" })
  readonly email!: string;

  @ApiProperty({ example: "USER", enum: ["USER", "ADMIN"], description: "User role" })
  readonly role!: string;
}
