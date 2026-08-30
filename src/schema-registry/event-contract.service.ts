import { Inject, Injectable, Logger } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { SCHEMA_REGISTRY, type PayloadContract, type SchemaRegistry, type Subject } from "./ports";
import { SchemaCompilationError, SchemaValidationError } from "./schema-registry.errors";

/**
 * The registry, compiled.
 *
 * Ajv turns each schema into a JavaScript function once, at boot, and every
 * subsequent validation is a call to it — which is what makes it affordable to
 * check every event on the way into the outbox, on the way onto the wire, and on
 * the way back off it. Compiling per message instead would put a code generator
 * on the hot path of a consumer.
 *
 * Compiling *at boot* has a second job. A schema that passes the profile check
 * and still will not compile is possible, because the two check different
 * things, and a service that started anyway would be one that has quietly
 * stopped validating. Here it is a failed deployment instead.
 *
 * ### Which version validates
 *
 * Always the newest one this build knows — the *reader schema*. Not the version
 * named in the message's `event-schema-version` header, and the difference
 * matters during a rollout, when a consumer routinely reads messages from
 * producers one or more versions ahead of it. Validating against the writer's
 * version would mean fetching a schema this build has never seen and trusting
 * whatever it says; validating against our own asks the only question a consumer
 * actually needs answered, which is whether *it* can read these bytes. The
 * FULL_TRANSITIVE gate is what makes the answer reliably yes for any writer in
 * the history, and the header is kept for diagnosis: a dead letter that says
 * "written by v4, rejected by v2" points straight at the replica that needs
 * upgrading.
 */
@Injectable()
export class EventContract implements PayloadContract {
  private readonly logger = new Logger(EventContract.name);

  /** Subject to its reader-schema validator. */
  private readonly validators = new Map<Subject, { version: number; fn: ValidateFunction }>();

  constructor(@Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry) {
    // `strict` catches a schema whose keywords Ajv does not recognise, which
    // would otherwise be ignored — a misspelled `requried` silently enforcing
    // nothing is exactly the failure a contract must not have. `allErrors`
    // because a rejected payload is a diagnosis: reporting only the first bad
    // field turns one fix into three round trips.
    const ajv = new Ajv({ strict: true, allErrors: true });
    // Without this, a `format` in a document is an annotation Ajv ignores. The
    // profile allows `format`, so it has to mean something.
    addFormats(ajv);

    for (const subject of registry.subjects()) {
      // Every version is compiled, not just the reader's, so a historical
      // document that no longer compiles fails the deployment rather than
      // waiting to be found by whoever next edits the history. Only the reader
      // schema is kept — it is the one `validate` uses.
      const readerVersion = registry.latest(subject).version;
      for (const registered of registry.versions(subject)) {
        let fn: ValidateFunction;
        try {
          fn = ajv.compile(registered.schema);
        } catch (caught: unknown) {
          throw new SchemaCompilationError(subject, registered.version, caught);
        }
        if (registered.version === readerVersion) {
          this.validators.set(subject, { version: registered.version, fn });
        }
      }
    }

    this.logger.log(
      `Validating ${this.validators.size} event contract(s) from the ${registry.name} registry: ` +
        [...this.validators.entries()]
          .map(([subject, { version }]) => `${subject} v${version}`)
          .join(", "),
    );
  }

  validate(name: Subject, payload: unknown): number {
    const compiled = this.validators.get(name);
    if (compiled === undefined) {
      // Unreachable through the typed call sites — `Subject` is
      // `DomainEventName` and the catalogue is exhaustive over it — but reachable
      // from a message whose `event-name` header this build recognises while its
      // catalogue does not, which is a half-finished catalogue entry. Reported
      // as a validation failure rather than crashing the consumer.
      throw new SchemaValidationError(name, 0, [`no compiled schema for "${name}"`]);
    }

    if (compiled.fn(payload)) return compiled.version;

    throw new SchemaValidationError(name, compiled.version, describe(compiled.fn));
  }

  /** The reader-schema version for a subject, without validating anything. */
  readerVersion(name: Subject): number {
    return this.registry.latest(name).version;
  }
}

/**
 * Ajv's errors as readable lines.
 *
 * `instancePath` is empty for a failure at the root, where `""` would read as a
 * missing field name, so it becomes the pointer to the document itself.
 */
function describe(fn: ValidateFunction): readonly string[] {
  return (fn.errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "#" : error.instancePath;
    return `${where} ${error.message ?? "is invalid"}`.trim();
  });
}
