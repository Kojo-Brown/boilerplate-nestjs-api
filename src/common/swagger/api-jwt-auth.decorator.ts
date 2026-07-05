import { applyDecorators } from "@nestjs/common";
import { ApiBearerAuth, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { BEARER_KEY } from "./setup-swagger";

/**
 * Marks an endpoint (or entire controller) as JWT-protected:
 * adds the lock icon in Swagger UI and documents the 401 response.
 */
export function ApiJwtAuth() {
  return applyDecorators(
    ApiBearerAuth(BEARER_KEY),
    ApiUnauthorizedResponse({ description: "Missing or invalid JWT access token" }),
  );
}
