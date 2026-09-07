import { JSON_SCHEMA_DRAFT, type EventSchema } from "../json-schema";

/**
 * `order.placed`, version 1.
 *
 * `totalMinor` is `integer` rather than `number`, which is the one constraint
 * worth asserting on the wire: money in this system is minor units, and a
 * consumer that received `19.99` where it expected `1999` would be wrong by a
 * factor of a hundred in a direction nobody notices until the reconciliation
 * report. Nothing else is constrained beyond its type, for the reason
 * `user.registered` gives — the request has already been through
 * class-validator, and a second, differently-spelled definition of a valid
 * order only creates a way to reject data the system has already accepted.
 *
 * `currency` is not an `enum` of ISO 4217, deliberately. Adding a currency
 * would then break forward compatibility for every consumer that had not
 * redeployed, in exchange for catching a typo in a string this service is the
 * sole writer of.
 */
const V1 = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: "urn:boilerplate-nestjs-api:schema:order.placed:1",
  title: "order.placed v1",
  description: "A customer has asked to buy something. Nothing is reserved, charged or shipped.",
  type: "object",
  additionalProperties: true,
  properties: {
    orderId: { type: "string", description: "The new order's id." },
    userId: { type: "string", description: "Who placed it." },
    totalMinor: {
      type: "integer",
      description: "Order total in minor units of `currency`.",
    },
    currency: { type: "string", description: "Upper-case ISO 4217 alphabetic code." },
    lineCount: { type: "integer", description: "How many lines the order has." },
  },
  required: ["orderId", "userId", "totalMinor", "currency", "lineCount"],
} as const satisfies EventSchema;

/** Oldest first. The last entry is the reader schema for this build. */
export const ORDER_PLACED_SCHEMAS = [V1] as const satisfies readonly EventSchema[];
