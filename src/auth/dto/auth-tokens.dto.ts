import { ApiProperty } from "@nestjs/swagger";

export class AuthTokensDto {
  @ApiProperty({
    description: "Short-lived JWT access token (default 15 min)",
    example:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAiLCJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJyb2xlIjoiVVNFUiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwOTAwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  })
  accessToken!: string;

  @ApiProperty({
    description: "Long-lived single-use refresh token (default 7 days). Invalidated on use.",
    example: "550e8400-e29b-41d4-a716-446655440000",
  })
  refreshToken!: string;

  @ApiProperty({ description: "Access token lifetime in seconds", example: 900 })
  expiresIn!: number;
}
