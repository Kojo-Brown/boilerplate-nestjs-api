import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { StorageService } from "./storage.service";
import { RequestPresignedGetUrlDto } from "./dto/request-presigned-get-url.dto";
import { RequestPresignedPutUrlDto } from "./dto/request-presigned-put-url.dto";
import { PresignedUrlDto } from "./dto/presigned-url.dto";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import { ApiCommonErrors } from "@/common/swagger/api-error-responses.decorator";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import type { PresignedUrlResult } from "./storage.service";

@ApiTags("storage")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard)
@Controller("storage")
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post("presigned-upload")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Request a presigned PUT URL",
    description:
      "Returns a short-lived URL the client can use to upload a file directly to S3 without routing through the API.",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(PresignedUrlDto) })
  @ApiCommonErrors()
  requestPresignedUpload(@Body() dto: RequestPresignedPutUrlDto): Promise<PresignedUrlResult> {
    return this.storage.getPresignedPutUrl(dto.key, dto.contentType, dto.expiresIn);
  }

  @Post("presigned-download")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Request a presigned GET URL",
    description:
      "Returns a short-lived URL the client can use to download a private S3 object directly without routing through the API.",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(PresignedUrlDto) })
  @ApiCommonErrors()
  requestPresignedDownload(@Body() dto: RequestPresignedGetUrlDto): Promise<PresignedUrlResult> {
    return this.storage.getPresignedGetUrl(dto.key, dto.expiresIn);
  }
}
