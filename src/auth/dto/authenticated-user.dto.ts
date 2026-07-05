import { ApiProperty } from "@nestjs/swagger";

export class AuthenticatedUserDto {
  @ApiProperty({ example: "550e8400-e29b-41d4-a716-446655440000", description: "User UUID" })
  id!: string;

  @ApiProperty({ example: "user@example.com" })
  email!: string;

  @ApiProperty({ example: "USER", enum: ["USER", "ADMIN"], description: "User role" })
  role!: string;
}
