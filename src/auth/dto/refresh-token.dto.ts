import { IsString, IsNotEmpty } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RefreshTokenDto {
  @ApiProperty({
    example: "550e8400-e29b-41d4-a716-446655440000",
    description: "Refresh token received from login / register / previous refresh call",
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
