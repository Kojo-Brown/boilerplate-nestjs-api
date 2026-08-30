import type { DomainEventName, DomainEventPayloads } from "@/events";
import type { EventSchema } from "../json-schema";
import { USER_DELETED_SCHEMAS } from "./user.deleted";
import { USER_REGISTERED_SCHEMAS } from "./user.registered";

/**
 * Every event's schema history, keyed by subject.
 *
 * A mapped type over `DomainEventName` rather than a `Record<string, ...>`, so
 * adding an event to the catalogue in `src/events/domain-event.ts` without
 * writing a schema for it is a compile error. That is the same trick
 * `PARTITION_KEY` uses in the codec, and for the same reason: the alternative is
 * an event that publishes fine, reaches the topic, and is dead-lettered by every
 * consumer because the writer had no contract to check it against.
 */
export const SCHEMA_CATALOGUE: {
  readonly [K in DomainEventName]: readonly EventSchema[];
} = {
  "user.registered": USER_REGISTERED_SCHEMAS,
  "user.deleted": USER_DELETED_SCHEMAS,
};

/**
 * One payload per event that the shipped schemas are expected to accept.
 *
 * These close the loop between the TypeScript catalogue and the JSON one, which
 * nothing else can: the compiler cannot check a JSON Schema document against an
 * interface, so without them the two drift silently and the first symptom is a
 * consumer rejecting a payload the producer's types said was fine.
 *
 * The loop works because the object is typed as the payload. Add a field to
 * `UserRegisteredPayload` and this stops compiling until the field is supplied
 * here; supply it and `catalogue.spec.ts` fails until the schema declares it;
 * declare it as *required* and the compatibility gate fails, because a new
 * required property is not backward compatible — so the only way through is to
 * add it as optional, which is the correct answer and the one a rushed change
 * would not have found.
 *
 * The values are obviously synthetic on purpose: they are fixtures, and a
 * fixture that looks like a real user's address is one somebody eventually
 * treats as one.
 */
export const REFERENCE_PAYLOADS: { readonly [K in DomainEventName]: DomainEventPayloads[K] } = {
  "user.registered": {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "reference-user@example.test",
    name: "Reference User",
    provider: null,
  },
  "user.deleted": {
    userId: "00000000-0000-4000-8000-000000000002",
    email: "reference-deleted@example.test",
  },
};

export { USER_DELETED_SCHEMAS, USER_REGISTERED_SCHEMAS };
