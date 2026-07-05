import { applyDecorators } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";

/** Documents 400 + 422 + 500 responses on a route. */
export function ApiCommonErrors() {
  return applyDecorators(
    ApiBadRequestResponse({ description: "Validation failed — check the request body / params" }),
    ApiUnprocessableEntityResponse({ description: "Business rule violation" }),
    ApiInternalServerErrorResponse({ description: "Unexpected server error" }),
  );
}

/** Documents a 404 Not Found response. */
export function ApiNotFound(entity = "Resource") {
  return applyDecorators(ApiNotFoundResponse({ description: `${entity} not found` }));
}

/** Documents a 409 Conflict response. */
export function ApiConflict(description = "Resource already exists") {
  return applyDecorators(ApiConflictResponse({ description }));
}

/** Documents a 403 Forbidden response (insufficient role / permissions). */
export function ApiForbiddenRole() {
  return applyDecorators(ApiForbiddenResponse({ description: "Insufficient permissions" }));
}
