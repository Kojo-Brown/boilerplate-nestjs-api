import { JSON_SCHEMA_DRAFT, type EventSchema } from "../json-schema";

/**
 * `user.deleted`, version 1.
 *
 * `email` is required here and not merely carried along: the row is gone by the
 * time a subscriber runs, so a handler that has to reach the person cannot look
 * the address up. That is why `UserDeletedPayload` documents this as the one
 * event that must be self-contained, and making the field required is that
 * requirement written down somewhere a consumer in another service can read it.
 */
const V1 = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: "urn:boilerplate-nestjs-api:schema:user.deleted:1",
  title: "user.deleted v1",
  description: "An account is gone. Emitted after the row is deleted, not before.",
  type: "object",
  additionalProperties: true,
  properties: {
    userId: { type: "string", description: "The id of the account that was deleted." },
    email: {
      type: "string",
      description: "Carried on the event because the row no longer exists to be read.",
    },
  },
  required: ["userId", "email"],
} as const satisfies EventSchema;

/** Oldest first. The last entry is the reader schema for this build. */
export const USER_DELETED_SCHEMAS = [V1] as const satisfies readonly EventSchema[];
