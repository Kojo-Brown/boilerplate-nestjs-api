import { Query } from "@nestjs/common";
import { ApiQuery } from "@nestjs/swagger";

/**
 * Combined parameter + Swagger decorator for cursor-based pagination.
 *
 * Extracts { cursor, limit } from the request query and annotates the
 * endpoint with @ApiQuery entries for Swagger UI.
 *
 * Usage:
 *   @Get()
 *   findAll(@Paginate() query: CursorPaginationDto): Promise<CursorPage<UserDto>> { ... }
 */
export function Paginate(): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    // Extract entire query object — ValidationPipe maps it to CursorPaginationDto
    Query()(target, propertyKey, parameterIndex);

    // Attach Swagger @ApiQuery docs at the method level
    if (propertyKey !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
      if (descriptor) {
        ApiQuery({
          name: "cursor",
          required: false,
          type: String,
          description: "Opaque cursor from the previous page response",
          example: "Y3Vyc29yOjE=",
        })(target, propertyKey as string, descriptor);
        ApiQuery({
          name: "limit",
          required: false,
          type: Number,
          minimum: 1,
          maximum: 100,
          description: "Items per page (1–100, default 20)",
          example: 20,
        })(target, propertyKey as string, descriptor);
      }
    }
  };
}
