import { ApiProperty } from "@nestjs/swagger";

export class PresignedUrlDto {
  @ApiProperty({ example: "https://s3.amazonaws.com/bucket/avatars/user-1/photo.jpg?X-Amz-Signature=abc123" })
  url!: string;

  @ApiProperty({ example: "avatars/user-1/1234567890.jpg" })
  key!: string;

  @ApiProperty({ example: "2024-01-01T01:00:00.000Z", description: "ISO 8601 timestamp when the URL expires" })
  expiresAt!: Date;
}
