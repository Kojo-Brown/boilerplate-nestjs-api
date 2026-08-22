import { IsEmail, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  readonly email!: string;

  @ApiProperty({ example: "P@ssw0rd123!" })
  @IsString()
  readonly password!: string;
}
