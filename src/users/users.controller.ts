import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiOkResponse, ApiParam } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { ApiNotFound } from "@/common/swagger/api-error-responses.decorator";

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":id")
  @ApiOperation({ summary: "Get user by ID" })
  @ApiParam({ name: "id", description: "User UUID", example: "550e8400-e29b-41d4-a716-446655440000" })
  @ApiOkResponse({ description: "User record" })
  @ApiNotFound("User")
  findOne(@Param("id") id: string) {
    return this.users.findById(id);
  }
}
