import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

export class RequestPresignedPutUrlDto {
  @ApiProperty({ example: "avatars/user-1/photo.jpg", description: "S3 object key for the upload destination" })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ example: "image/jpeg", description: "MIME type of the file to be uploaded" })
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiPropertyOptional({
    example: 3600,
    description: "URL validity in seconds. Min 60, max 604800 (7 days). Defaults to 3600.",
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(604800)
  expiresIn?: number;
}
