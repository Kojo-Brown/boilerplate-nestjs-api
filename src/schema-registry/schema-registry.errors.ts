import type { Incompatibility } from "./compatibility";

/** A subject was asked for that this build has no schema for. */
export class SubjectNotRegisteredError extends Error {
  constructor(
    readonly subject: string,
    known: readonly string[],
  ) {
    super(
      `No schema is registered for "${subject}". Known subjects: ${known.join(", ") || "(none)"}. ` +
        `Every name in DOMAIN_EVENT_NAMES needs an entry in src/schema-registry/catalogue.`,
    );
    this.name = "SubjectNotRegisteredError";
  }
}

/**
 * A payload does not conform to its event's schema.
 *
 * Carries the Ajv messages rather than a summary, because the useful content of
 * a validation failure is *which* field and *how* — "/email must be string" is
 * actionable where "invalid payload" starts an investigation.
 */
export class SchemaValidationError extends Error {
  constructor(
    readonly subject: string,
    readonly version: number,
    readonly violations: readonly string[],
  ) {
    super(
      `Payload does not conform to "${subject}" v${version}: ${violations.join("; ")}. ` +
        `Either the payload is wrong, or the schema in src/schema-registry/catalogue ` +
        `no longer describes the event.`,
    );
    this.name = "SchemaValidationError";
  }
}

/**
 * A schema in the catalogue could not be compiled into a validator.
 *
 * Thrown from the contract's constructor, so it is a boot failure. A schema that
 * passes the profile check and still will not compile is possible — the profile
 * covers structure, Ajv covers meta-schema conformance — and a service that
 * starts anyway would be one that has stopped validating without saying so.
 */
export class SchemaCompilationError extends Error {
  constructor(subject: string, version: number, cause: unknown) {
    super(
      `Could not compile "${subject}" v${version}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "SchemaCompilationError";
  }
}

export type { Incompatibility };
export { IncompatibleEvolutionError } from "./compatibility";
export { SchemaProfileError } from "./json-schema";
