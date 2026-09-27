import type { LogEvent } from "./log-event";
import type { LogProcessor } from "./log-processor";
import { redactFields } from "./redact-fields";
import { compileAllowlist, DEFAULT_ALLOWLIST } from "./redaction-allowlist";
import { scrubSecrets } from "./scrub-secrets";
import { parseExtraAllowlist, readLoggingEnv } from "./logging.env";

/**
 * Scrubs credentials out of the free-text message.
 *
 * This is the whole of the protection the message gets, and saying so plainly is
 * more useful than implying more. There is no key to look up, so the allowlist
 * has nothing to decide with; what is left is the credential patterns, which
 * catch a token somebody interpolated and will not catch a name, an address or
 * a diagnosis.
 *
 * Which is why it runs at all: a message is where a credential most often ends
 * up by accident — `Request to ${url} failed`, with the signed URL in it — and
 * catching that is worth a pass even though the same pass does nothing for the
 * PII case. Fields are the answer for PII. See `docs/log-redaction.md`.
 */
export const scrubMessage: LogProcessor = (event) => ({
  ...event,
  message: scrubSecrets(event.message),
});

/** The chain, in the order it runs. */
export function buildProcessorChain(extraAllowlist: readonly string[]): {
  processors: readonly LogProcessor[];
  patterns: readonly string[];
  rejected: readonly string[];
} {
  const { allowlist, rejected } = compileAllowlist([...DEFAULT_ALLOWLIST, ...extraAllowlist]);
  return {
    // The field redactor runs last, and the order is not arbitrary: any
    // processor that enriches a record — adding a tenant, a release, a
    // hostname — must be upstream of the thing that decides what may be
    // logged, or it would be adding fields *after* the decision and shipping
    // them unexamined. "Redaction is the final step" is the property to keep
    // when this chain grows.
    processors: [scrubMessage, redactFields(allowlist)],
    patterns: allowlist.patterns,
    rejected,
  };
}

/**
 * A chain that redacts nothing, for `LOG_REDACTION_ENABLED=false`.
 *
 * Still a chain rather than a `null` the logger branches on, so that the enabled
 * and disabled paths differ in their contents and not in their shape — the
 * disabled path is exercised by the same code as the enabled one, so it cannot
 * rot into a path that crashes the only time anybody uses it.
 */
export const PASSTHROUGH_PROCESSORS: readonly LogProcessor[] = [];

/** Renders the structured half for a text sink. Stable key order, for grep and diff. */
export function renderFields(event: LogEvent): string | undefined {
  const keys = Object.keys(event.fields).sort();
  if (keys.length === 0) return undefined;
  const ordered: Record<string, unknown> = {};
  for (const key of keys) ordered[key] = event.fields[key];
  try {
    return JSON.stringify(ordered);
  } catch {
    // A BigInt survives redaction as a string and a cycle is cut by the walker,
    // so reaching here means a value this module did not anticipate. Emitting
    // the marker keeps the line well-formed; emitting a partial serialisation
    // would not.
    return '{"fields":"[unserialisable]"}';
  }
}

/**
 * The chain this process runs, built once.
 *
 * Memoised because it is read on the construction of every `TelemetryLogger` —
 * one per `new Logger()` in the application — and compiling the allowlist per
 * instance would repeat the same parse hundreds of times to reach the same
 * answer. `reset` exists for specs, which need to build a chain from a different
 * environment in the same process.
 */
let cached: readonly LogProcessor[] | undefined;

export function defaultProcessors(): readonly LogProcessor[] {
  if (cached === undefined) {
    const env = readLoggingEnv();
    cached = env.LOG_REDACTION_ENABLED
      ? buildProcessorChain(parseExtraAllowlist(env.LOG_REDACTION_EXTRA_ALLOWLIST)).processors
      : PASSTHROUGH_PROCESSORS;
  }
  return cached;
}
