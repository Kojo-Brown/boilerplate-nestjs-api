import { JSON_SCHEMA_DRAFT, type EventSchema } from "../json-schema";

/**
 * `order.confirmed`, version 1.
 *
 * `paymentId` and `shipmentId` are required, and that is a statement about when
 * this event may be emitted rather than about JSON. It is staged by the last
 * step of the checkout saga, past the pivot — so by construction the money has
 * been captured and the parcel has been booked, and an event that could not name
 * both would be describing an order that is not actually confirmed.
 */
const V1 = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: "urn:boilerplate-nestjs-api:schema:order.confirmed:1",
  title: "order.confirmed v1",
  description: "Paid and shipped. The checkout saga completed.",
  type: "object",
  additionalProperties: true,
  properties: {
    orderId: { type: "string", description: "The order that was confirmed." },
    userId: { type: "string", description: "Whose order it is." },
    paymentId: {
      type: "string",
      description: "The gateway's payment id, for reconciliation.",
    },
    shipmentId: { type: "string", description: "The carrier booking." },
  },
  required: ["orderId", "userId", "paymentId", "shipmentId"],
} as const satisfies EventSchema;

/** Oldest first. The last entry is the reader schema for this build. */
export const ORDER_CONFIRMED_SCHEMAS = [V1] as const satisfies readonly EventSchema[];
