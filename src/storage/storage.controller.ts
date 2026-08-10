import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { StorageService } from "./storage.service";
import { RequestPresignedGetUrlDto } from "./dto/request-presigned-get-url.dto";
import { RequestPresignedPutUrlDto } from "./dto/request-presigned-put-url.dto";
import { PresignedUrlDto } from "./dto/presigned-url.dto";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import { ApiCommonErrors } from "@/common/swagger/api-error-responses.decorator";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import type { PresignedUrlResult } from "./storage.service";

/**
 * Documents the 501 both presign endpoints answer when the active adapter
 * cannot sign — a deployment-level fact rather than a per-request one, which is
 * why it is a documented response rather than an error the client can avoid by
 * changing its input.
 */
function ApiNotImplementedForAdapter(): MethodDecorator {
  return ApiResponse({
    status: HttpStatus.NOT_IMPLEMENTED,
    description:
      "The configured storage adapter cannot issue presigned URLs. Upload through the API instead.",
  });
}

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
      "Returns a short-lived URL the client can use to upload a file directly to the object store " +
      "without routing through the API. Only available when STORAGE_ADAPTER=s3 — a filesystem has " +
      "nothing to verify a signature with, so the other backends answer 501.",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(PresignedUrlDto) })
  @ApiNotImplementedForAdapter()
  @ApiCommonErrors()
  requestPresignedUpload(@Body() dto: RequestPresignedPutUrlDto): Promise<PresignedUrlResult> {
    return this.storage.getPresignedPutUrl(dto.key, dto.contentType, dto.expiresIn);
  }

  @Post("presigned-download")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Request a presigned GET URL",
    description:
      "Returns a short-lived URL the client can use to download a private object directly without " +
      "routing through the API. Only available when STORAGE_ADAPTER=s3; see the upload endpoint.",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(PresignedUrlDto) })
  @ApiNotImplementedForAdapter()
  @ApiCommonErrors()
  requestPresignedDownload(@Body() dto: RequestPresignedGetUrlDto): Promise<PresignedUrlResult> {
    return this.storage.getPresignedGetUrl(dto.key, dto.expiresIn);
  }
}
