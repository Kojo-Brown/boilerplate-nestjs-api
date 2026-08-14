import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { CacheKey, CacheTTL, HttpCacheInterceptor } from "@/common/cache";
import {
  ApiConditionalWrite,
  ApiEntityTag,
  IfMatch,
  versioned,
  type ExpectedVersion,
} from "@/common/concurrency";
import { UserResourceCacheInterceptor } from "./user-resource.cache.interceptor";
import { USERS_LIST_CACHE_KEY } from "./users.service";
import { UsersService } from "./users.service";
import { UserAccessPolicy } from "./users.access-policy";
import { StorageService } from "@/storage/storage.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UserResponseDto } from "./dto/user-response.dto";
import { UserPreferencesDto } from "./dto/user-preferences.dto";
import { UpdateUserPreferencesDto } from "./dto/update-user-preferences.dto";
import { ListUsersQueryDto } from "./dto/list-users-query.dto";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { RolesGuard } from "@/auth/guards/roles.guard";
import { Roles } from "@/common/decorators/roles.decorator";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import {
  ApiCommonErrors,
  ApiForbiddenRole,
  ApiNotFound,
} from "@/common/swagger/api-error-responses.decorator";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import { CursorPageOf } from "@/common/pagination";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";

const AVATAR_ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const AVATAR_MAX_SIZE_BYTES = 5 * 1024 * 1024;

@ApiTags("users")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly storage: StorageService,
    private readonly policy: UserAccessPolicy,
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  @UseInterceptors(HttpCacheInterceptor)
  @CacheKey(USERS_LIST_CACHE_KEY)
  @CacheTTL(60_000)
  @ApiOperation({
    summary: "List users (admin)",
    description: "Cursor-paginated list of all users. Admin only.",
  })
  @ApiOkResponse({ type: CursorPageOf(UserResponseDto) })
  @ApiForbiddenRole()
  @ApiCommonErrors()
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.users.listUsers(query);
  }

  @Get(":id")
  @UseInterceptors(UserResourceCacheInterceptor)
  @CacheTTL(30_000)
  @ApiOperation({
    summary: "Get user by ID",
    description:
      "Returns the user and an `ETag` naming its version. Send that `ETag` back in `If-Match` to modify it.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserResponseDto) })
  @ApiEntityTag()
  @ApiNotFound("User")
  @ApiCommonErrors()
  async findOne(@Param("id") id: string) {
    const user = await this.users.findById(id);
    return versioned(user, user.version);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update user profile",
    description:
      "A user may update their own profile. Admins may update any user. Requires `If-Match`: the write applies only if the user is still at the version named there, and answers 412 otherwise.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserResponseDto) })
  @ApiConditionalWrite()
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() requester: AuthenticatedUser,
    @IfMatch() expected: ExpectedVersion,
  ) {
    const user = await this.users.updateSelf(requester, id, dto, expected);
    return versioned(user, user.version);
  }

  @Post(":id/avatar")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: AVATAR_MAX_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (AVATAR_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              `Invalid file type. Allowed types: ${AVATAR_ALLOWED_MIME_TYPES.join(", ")}`,
            ),
            false,
          );
        }
      },
    }),
  )
  @ApiOperation({
    summary: "Upload user avatar to S3",
    description:
      "Replaces the user's avatar with the uploaded image. Max 5 MB. Accepted types: JPEG, PNG, WebP, GIF.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", format: "binary", description: "Image file (max 5 MB)" },
      },
    },
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserResponseDto) })
  @ApiConditionalWrite()
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async uploadAvatar(
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() requester: AuthenticatedUser,
    @IfMatch() expected: ExpectedVersion,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    // Checked here rather than in `updateAvatar` so a forbidden request never
    // reaches S3 — the upload happens before the row is touched.
    this.policy.assertCanAct(requester, id, "update:avatar");
    // Same reasoning for the precondition: a request that already cannot win
    // should not leave a 5 MB object in the bucket that nothing will ever
    // reference. This does not make the write safe — the row can still move
    // between here and the update, which is what the conditional write below
    // is for — it just keeps the common conflict from costing an upload.
    await this.users.assertPrecondition(id, expected);
    const ext = (file.originalname.split(".").pop() ?? "bin").toLowerCase();
    const key = `avatars/${id}/${Date.now()}.${ext}`;
    await this.storage.uploadBuffer(key, file.buffer, file.mimetype);
    const user = await this.users.updateAvatar(id, key, expected);
    return versioned(user, user.version);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete user (admin)" })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiNoContentResponse({ description: "User deleted" })
  @ApiConditionalWrite()
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  remove(@Param("id") id: string, @IfMatch() expected: ExpectedVersion) {
    return this.users.remove(id, expected);
  }

  @Get(":id/preferences")
  @ApiOperation({
    summary: "Get user preferences",
    description:
      "Returns the typed preferences for a user. Defaults are applied to unset fields. Users may only read their own preferences; admins may read any.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserPreferencesDto) })
  @ApiEntityTag()
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async getPreferences(@Param("id") id: string, @CurrentUser() requester: AuthenticatedUser) {
    const { preferences, version } = await this.users.getPreferences(requester, id);
    return versioned(preferences, version);
  }

  @Patch(":id/preferences")
  @ApiOperation({
    summary: "Update user preferences",
    description:
      "Merges the provided fields into the user's stored preferences. Users may only update their own preferences; admins may update any. Requires `If-Match`; preferences share the user row's version, so a concurrent profile edit also invalidates it.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserPreferencesDto) })
  @ApiConditionalWrite()
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async updatePreferences(
    @Param("id") id: string,
    @Body() dto: UpdateUserPreferencesDto,
    @CurrentUser() requester: AuthenticatedUser,
    @IfMatch() expected: ExpectedVersion,
  ) {
    const { preferences, version } = await this.users.updatePreferences(
      requester,
      id,
      dto,
      expected,
    );
    return versioned(preferences, version);
  }
}
