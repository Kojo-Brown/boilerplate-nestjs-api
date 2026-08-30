import type { DomainEventName } from "@/events";
import type { EventSchema } from "../json-schema";

/** Injection token for the process's {@link SchemaRegistry}. */
export const SCHEMA_REGISTRY = Symbol("SCHEMA_REGISTRY");

/**
 * Which implementation backs `SchemaRegistry`.
 *
 * One name today, and the enum exists anyway for the same reason
 * `OUTBOX_PUBLISHER_NAMES` did before there was a broker: it is the shape the
 * second implementation slots into, and adding it should be a case rather than a
 * refactor. See {@link SchemaRegistry} for what a remote one would have to
 * solve first.
 */
export const SCHEMA_REGISTRY_NAMES = ["local"] as const;

export type SchemaRegistryName = (typeof SCHEMA_REGISTRY_NAMES)[number];

/**
 * The name a schema is registered under.
 *
 * This is Confluent's *RecordNameStrategy*: the subject is the event name, not
 * the topic. The default everywhere is TopicNameStrategy — `<topic>-value` —
 * and it is wrong here for a reason that is structural rather than stylistic.
 * `domain-event-codec.ts` deliberately puts every event on one topic so that
 * `user.registered` and `user.deleted` stay ordered against each other, which
 * means one topic carries several unrelated payload shapes. Under
 * TopicNameStrategy they would all be versions of one subject, and every
 * alternation between two event types would read as an incompatible evolution
 * of a single schema.
 *
 * A subject is therefore the event's own name, and evolution is tracked per
 * event, which is the thing that actually evolves.
 */
export type Subject = DomainEventName;

/** One schema, at one version, under one subject. */
export interface RegisteredSchema {
  readonly subject: Subject;
  /** 1-based and contiguous, as a registry numbers them. */
  readonly version: number;
  readonly schema: EventSchema;
}

/**
 * Where event contracts come from.
 *
 * The only implementation is {@link import("../local-schema-registry").LocalSchemaRegistry},
 * which serves the catalogue checked into this repository. That is a deliberate
 * starting point rather than a placeholder: the schemas are versioned by the
 * same commit that changes the code they describe, the compatibility gate runs
 * in the same CI job as the tests, and a rollback takes the contract back with
 * it — none of which is true of a schema that lives in a server somebody
 * updates out of band.
 *
 * What a remote registry (Confluent, Apicurio) buys is a contract shared with
 * services that are not in this repository, and this port is the seam it binds
 * to. Two things have to be decided before one is worth adding, and neither is
 * decided here: a fetch on the path of every message needs a cache with an
 * eviction policy, and a registry that is unreachable at boot has to either fail
 * the deployment or start with a stale cache — the same fail-closed question
 * `IdempotencyStore` answers with a 503. Until then the local registry is
 * honest about being local, and `docs/schema-registry.md` says what publishing
 * the catalogue to a remote one would involve.
 */
export interface SchemaRegistry {
  readonly name: SchemaRegistryName;

  /** Every subject this registry knows, in no particular order. */
  subjects(): readonly Subject[];

  /**
   * Every version of a subject, oldest first.
   *
   * The whole history rather than just the latest, because the compatibility
   * gate needs all of it: FULL_TRANSITIVE is a property of the set, not of the
   * most recent pair.
   */
  versions(subject: Subject): readonly RegisteredSchema[];

  /**
   * The newest version of a subject — the *reader schema* for this build.
   *
   * Throws {@link import("../schema-registry.errors").SubjectNotRegisteredError}
   * rather than returning `undefined`: every event in the catalogue is required
   * to have a subject, so an absent one is a wiring bug that should surface at
   * boot rather than a case each caller handles.
   */
  latest(subject: Subject): RegisteredSchema;
}

/**
 * The narrow view the codec and the outbox take of the registry: "is this
 * payload a valid `user.registered`, and which version says so?"
 *
 * Separate from {@link SchemaRegistry} because those call sites have no business
 * enumerating subjects or reading schema documents, and because it is the
 * interface a compiled validator implements rather than a store of documents.
 */
export interface PayloadContract {
  /**
   * Validates `payload` against the latest schema for `name` and returns that
   * schema's version.
   *
   * Throws {@link import("../schema-registry.errors").SchemaValidationError} if
   * it does not conform. Returning the version rather than `void` is what lets
   * the caller stamp `event-schema-version` on the wire without a second lookup
   * that could disagree with the one that validated.
   */
  validate(name: Subject, payload: unknown): number;
}
