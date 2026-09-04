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
import { CommandBus, QueryBus } from "@nestjs/cqrs";
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
import {
  GetUserPreferencesQuery,
  GetUserQuery,
  ListUsersQuery,
  USERS_LIST_CACHE_KEY,
} from "./read";
import {
  DeleteUserCommand,
  UpdateUserAvatarCommand,
  UpdateUserPreferencesCommand,
  UpdateUserProfileCommand,
} from "./write";
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

/**
 * HTTP for the users resource, and nothing else.
 *
 * Every endpoint is a translation: parse and validate the request, dispatch one
 * command or one query, shape the answer. There is no branching left here — the
 * ownership checks, the preconditions, the S3 upload and the object key all
 * moved into the handlers, because each of them was a decision about what the
 * operation *means* rather than about how it arrives. What remains is the part
 * that is genuinely HTTP: the multipart limits, the cache interceptors, the
 * `ETag` written by `versioned()`, and the OpenAPI description.
 */
@ApiTags("users")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
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
    return this.queries.execute(new ListUsersQuery(query));
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
    const user = await this.queries.execute(new GetUserQuery(id));
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
    const user = await this.commands.execute(
      new UpdateUserProfileCommand(requester, id, dto, expected),
    );
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
    // The only check left in the controller, and it belongs here: "the
    // multipart body carried no `file` part" is a statement about the request,
    // not about the user being changed.
    if (!file) throw new BadRequestException("No file uploaded");
    const user = await this.commands.execute(
      new UpdateUserAvatarCommand(requester, id, file, expected),
    );
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
    return this.commands.execute(new DeleteUserCommand(id, expected));
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
    const { preferences, version } = await this.queries.execute(
      new GetUserPreferencesQuery(requester, id),
    );
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
    const { preferences, version } = await this.commands.execute(
      new UpdateUserPreferencesCommand(requester, id, dto, expected),
    );
    return versioned(preferences, version);
  }
}
