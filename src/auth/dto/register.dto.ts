import { IsEmail, IsString, MinLength, IsOptional } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RegisterDto {
  @ApiProperty({ example: "user@example.com", description: "A unique email address" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "P@ssw0rd123!", description: "At least 8 characters", minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: "Jane Doe", description: "Display name (optional)", required: false })
  @IsOptional()
  @IsString()
  name?: string;
}
