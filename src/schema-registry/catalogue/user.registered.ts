import { JSON_SCHEMA_DRAFT, type EventSchema } from "../json-schema";

/**
 * `user.registered`, version 1.
 *
 * Every property is required and none is constrained beyond its type, which is a
 * deliberate reading of what this contract is for. `email` is not `format:
 * "email"` — the address has already been through `class-validator` at the API
 * edge, and asserting a *second*, differently-spelled definition of a valid
 * address on the wire only creates a way for the system to reject data it
 * already accepted. `provider` is not an `enum` of the OAuth providers for the
 * same reason in the other direction: adding a provider would then be a schema
 * change that breaks forward compatibility for every consumer not yet
 * redeployed, in exchange for catching a typo in a string this service is the
 * sole writer of.
 *
 * `name` and `provider` are `["string", "null"]` rather than optional. That is
 * the shape the TypeScript payload declares — `string | null`, always present —
 * and the distinction matters on the wire, because "absent" and "explicitly
 * null" are different bytes and a consumer written against one of them breaks on
 * the other.
 */
const V1 = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: "urn:boilerplate-nestjs-api:schema:user.registered:1",
  title: "user.registered v1",
  description: "A new account exists — email + password, or an OAuth profile.",
  type: "object",
  additionalProperties: true,
  properties: {
    userId: { type: "string", description: "The new user's id." },
    email: { type: "string", description: "The address the account was created with." },
    name: {
      type: ["string", "null"],
      description: "Display name, or null when the profile did not supply one.",
    },
    provider: {
      type: ["string", "null"],
      description: '"google" for OAuth sign-ups, null for email + password.',
    },
  },
  required: ["userId", "email", "name", "provider"],
} as const satisfies EventSchema;

/** Oldest first. The last entry is the reader schema for this build. */
export const USER_REGISTERED_SCHEMAS = [V1] as const satisfies readonly EventSchema[];
