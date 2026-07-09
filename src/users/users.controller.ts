import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { UsersService } from "./users.service";
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
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  @ApiOperation({ summary: "List users (admin)", description: "Cursor-paginated list of all users. Admin only." })
  @ApiOkResponse({ type: CursorPageOf(UserResponseDto) })
  @ApiForbiddenRole()
  @ApiCommonErrors()
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.users.listUsers(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get user by ID" })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserResponseDto) })
  @ApiNotFound("User")
  @ApiCommonErrors()
  findOne(@Param("id") id: string) {
    return this.users.findById(id);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update user profile",
    description: "A user may update their own profile. Admins may update any user.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserResponseDto) })
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  update(
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() requester: AuthenticatedUser,
  ) {
    return this.users.updateSelf(requester.id, id, dto, requester.role);
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
  @ApiOperation({ summary: "Upload user avatar to S3", description: "Replaces the user's avatar with the uploaded image. Max 5 MB. Accepted types: JPEG, PNG, WebP, GIF." })
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
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async uploadAvatar(
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() requester: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    if (requester.id !== id && requester.role !== "ADMIN") {
      throw new ForbiddenException("Cannot modify another user's avatar");
    }
    const ext = (file.originalname.split(".").pop() ?? "bin").toLowerCase();
    const key = `avatars/${id}/${Date.now()}.${ext}`;
    await this.storage.uploadBuffer(key, file.buffer, file.mimetype);
    return this.users.updateAvatar(id, key);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete user (admin)" })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiNoContentResponse({ description: "User deleted" })
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  remove(@Param("id") id: string) {
    return this.users.remove(id);
  }

  @Get(":id/preferences")
  @ApiOperation({
    summary: "Get user preferences",
    description: "Returns the typed preferences for a user. Defaults are applied to unset fields. Users may only read their own preferences; admins may read any.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserPreferencesDto) })
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  getPreferences(@Param("id") id: string, @CurrentUser() requester: AuthenticatedUser) {
    return this.users.getPreferences(id, requester.id, requester.role);
  }

  @Patch(":id/preferences")
  @ApiOperation({
    summary: "Update user preferences",
    description: "Merges the provided fields into the user's stored preferences. Users may only update their own preferences; admins may update any.",
  })
  @ApiParam({ name: "id", description: "User CUID", example: "clxxxxxxxxxxxxxxxx" })
  @ApiOkResponse({ type: ApiEnvelopeOf(UserPreferencesDto) })
  @ApiNotFound("User")
  @ApiForbiddenRole()
  @ApiCommonErrors()
  updatePreferences(
    @Param("id") id: string,
    @Body() dto: UpdateUserPreferencesDto,
    @CurrentUser() requester: AuthenticatedUser,
  ) {
    return this.users.updatePreferences(id, requester.id, requester.role, dto);
  }
}
