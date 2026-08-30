import { DOMAIN_EVENT_NAMES } from "@/events";
import { SCHEMA_CATALOGUE } from "./catalogue";
import { assertHistoryIsFullyCompatible } from "./compatibility";
import { assertInProfile, type EventSchema } from "./json-schema";
import { SubjectNotRegisteredError } from "./schema-registry.errors";
import type { RegisteredSchema, SchemaRegistry, SchemaRegistryName, Subject } from "./ports";

/**
 * The catalogue checked into this repository, served as a registry.
 *
 * Versions are positions in an array: the first entry is v1 and the last is the
 * reader schema for this build. Numbering by position rather than by a field in
 * each document means the two can never disagree, and it makes "what is the
 * newest version" a property of the file rather than something to be searched
 * for.
 *
 * The constructor runs the same two checks the CI gate runs — every document is
 * in the supported profile, and every history is FULL_TRANSITIVE compatible —
 * and that duplication is deliberate. The gate is what fails a pull request;
 * this is what stops a process from booting with a contract it cannot honour,
 * which is the state a merge that bypassed CI, a bad rebase, or a hand-edited
 * deployment would otherwise leave it in. Both are cheap: the catalogue is a few
 * documents, and this runs once per process.
 *
 * Not `@Injectable()`, and bound by a factory rather than `useClass`. Its one
 * constructor parameter is the catalogue, defaulted so production never passes
 * one and a test can substitute a history of its own — but a default does not
 * make a parameter invisible to Nest, which reads `design:paramtypes` and tries
 * to resolve an `Object` it has no provider for. A factory is the honest way to
 * say that this class is constructed rather than injected into.
 */
export class LocalSchemaRegistry implements SchemaRegistry {
  readonly name: SchemaRegistryName = "local";

  private readonly bySubject = new Map<Subject, readonly RegisteredSchema[]>();

  constructor(catalogue: { readonly [K in Subject]: readonly EventSchema[] } = SCHEMA_CATALOGUE) {
    for (const subject of DOMAIN_EVENT_NAMES) {
      const history = catalogue[subject];
      if (history.length === 0) {
        throw new SubjectNotRegisteredError(subject, []);
      }

      const versions = history.map((schema, index) => {
        assertInProfile(schema, `#(${subject} v${index + 1})`);
        return { subject, version: index + 1, schema };
      });
      assertHistoryIsFullyCompatible(subject, versions);

      this.bySubject.set(subject, versions);
    }
  }

  subjects(): readonly Subject[] {
    return [...this.bySubject.keys()];
  }

  versions(subject: Subject): readonly RegisteredSchema[] {
    const history = this.bySubject.get(subject);
    if (history === undefined) throw new SubjectNotRegisteredError(subject, this.knownSubjects());
    return history;
  }

  latest(subject: Subject): RegisteredSchema {
    const history = this.versions(subject);
    // Non-null: the constructor refuses an empty history, so every subject in
    // the map has at least a v1.
    return history[history.length - 1]!;
  }

  private knownSubjects(): readonly string[] {
    return [...this.bySubject.keys()];
  }
}
