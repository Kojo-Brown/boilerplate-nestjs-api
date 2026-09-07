import { JSON_SCHEMA_DRAFT, type EventSchema } from "../json-schema";

/**
 * `order.cancelled`, version 1.
 *
 * `reason` is a free-text string and not an `enum` of failure codes, which is
 * the more useful shape today and the harder one to change later. An enum would
 * let a consumer branch on *why* — retry a payment failure, apologise for an
 * out-of-stock — but every new failure mode would then be an incompatible
 * schema change under a FULL gate, and this service invents failure modes every
 * time a participant does. The string is what the customer is shown; a coded
 * `reasonCode` can be added later as an optional property, which is the one
 * evolution the compatibility rules permit.
 */
const V1 = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: "urn:boilerplate-nestjs-api:schema:order.cancelled:1",
  title: "order.cancelled v1",
  description: "A checkout that could not be completed and was unwound.",
  type: "object",
  additionalProperties: true,
  properties: {
    orderId: { type: "string", description: "The order that was cancelled." },
    userId: { type: "string", description: "Whose order it was." },
    reason: {
      type: "string",
      description: "The failing step's message, as the customer will be shown it.",
    },
  },
  required: ["orderId", "userId", "reason"],
} as const satisfies EventSchema;

/** Oldest first. The last entry is the reader schema for this build. */
export const ORDER_CANCELLED_SCHEMAS = [V1] as const satisfies readonly EventSchema[];
