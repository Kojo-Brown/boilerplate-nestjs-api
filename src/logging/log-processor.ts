import { REDACTED, type LogEvent } from "./log-event";
import { scrubSecrets } from "./scrub-secrets";

/**
 * One step in the pipeline — structlog's processor, with its two powers.
 *
 * Returning an event passes it on, possibly changed. Returning `null` drops the
 * line entirely, which is what makes sampling, rate limiting and "never log
 * health checks" processors rather than special cases inside the logger.
 *
 * Processors are plain functions of one argument and no `this`, so each is
 * testable without a logger, a Nest module or a container. That is most of why
 * the pattern is worth borrowing: the interesting logic — what counts as
 * sensitive — ends up in functions a spec can call directly, instead of inside
 * a class that has to be wired up before it can be asked a question.
 */
export type LogProcessor = (event: LogEvent) => LogEvent | null;

/** Told about a processor that threw, so a broken chain is visible rather than quiet. */
export type ProcessorFailureReporter = (error: unknown, event: LogEvent) => void;

/**
 * Runs a chain, and **fails closed**.
 *
 * The direction of that failure is the whole design. A processor that throws
 * has, by definition, not finished deciding what in this record was safe — so
 * the record cannot be emitted. The tempting fallbacks are both wrong:
 *
 *   * Emitting the original is fail-*open*. The redactor's own bug becomes the
 *     disclosure, and it happens on the record that was unusual enough to break
 *     it — which is disproportionately the interesting one.
 *   * Emitting nothing loses the line silently. A redactor that throws on every
 *     record would then present as a service that has stopped logging, and the
 *     cause would be invisible precisely because the evidence is what is
 *     missing.
 *
 * So a failure produces a **substitute** record: same level and context, no
 * content, and the error's type so the bug can be found. It is louder than the
 * original line and carries none of it.
 *
 * `partial` matters too. A chain that fails at step three must not emit what
 * steps one and two produced: those are intermediate states, and if the
 * redacting processor has not run yet the intermediate is the raw record. The
 * substitute is built from the *input*'s level and context only, both of which
 * are developer-chosen and neither of which is data.
 */
export function runProcessors(
  processors: readonly LogProcessor[],
  event: LogEvent,
  onFailure?: ProcessorFailureReporter,
): LogEvent | null {
  let current: LogEvent = event;
  for (const processor of processors) {
    try {
      const next = processor(current);
      if (next === null) return null;
      current = next;
    } catch (error) {
      onFailure?.(error, current);
      return failureSubstitute(event, error);
    }
  }
  return current;
}

/**
 * The record emitted in place of one the chain could not process.
 *
 * The message is fixed text, not the original: an original message is exactly
 * the free-text field this module cannot vouch for. The error's constructor name
 * is included because it is the one detail that makes the bug findable and is
 * chosen by a programmer rather than by data — and `error.message` is
 * deliberately *not*, since a thrown message routinely quotes the value that
 * caused it, which here is the value being redacted. It is scrubbed anyway, on
 * the principle that a constructor name is only nearly always safe.
 */
function failureSubstitute(event: LogEvent, error: unknown): LogEvent {
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  return {
    level: "error",
    message:
      "log redaction failed; this record's content has been withheld " +
      `(processor threw ${scrubSecrets(errorType)})`,
    context: event.context,
    fields: { redactionFailed: true, originalLevel: event.level, message: REDACTED },
  };
}
