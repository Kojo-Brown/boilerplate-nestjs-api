import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiParam,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UserResponseDto } from "./dto/user-response.dto";
import { ListUsersQueryDto } from "./dto/list-users-query.dto";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { RolesGuard } from "@/auth/guards/roles.guard";
import { Roles } from "@/common/decorators/roles.decorator";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import {
  ApiCommonErrors,
  ApiNotFound,
  ApiForbiddenRole,
} from "@/common/swagger/api-error-responses.decorator";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import { CursorPageOf } from "@/common/pagination";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";

@ApiTags("users")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

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
}
