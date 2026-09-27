import { WILDCARD_SEGMENT, matchesPattern, parsePattern } from "./field-path";

/**
 * A compiled set of the field paths that may be logged in the clear.
 *
 * Compiled once at boot rather than parsed per line: this is consulted for
 * every field of every log record, which on a busy service is the hottest loop
 * in the logging path.
 */
export interface RedactionAllowlist {
  /** Whether a concrete field path may keep its value. */
  admits(path: readonly string[]): boolean;
  /** The patterns, as given. For the boot log line that states what is in force. */
  readonly patterns: readonly string[];
}

/**
 * The paths this service logs deliberately.
 *
 * Every entry is a decision that somebody has to be able to defend, which is
 * why the list is short and why it is here rather than assembled from
 * `@LogSafe()` decorators scattered over the codebase. An allowlist that is
 * hard to read is an allowlist nobody audits, and one that can be extended from
 * anywhere is one that grows without review.
 *
 * What is *not* here is the point of the exercise: no request body, no query
 * parameter that has not been named, no header, no user attribute other than
 * the opaque id. A field added to a log line tomorrow is redacted until it
 * appears in this list, and that is the intended order of events — the
 * redaction is the default and the exposure is the change under review.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  // ── The access log (`LoggingInterceptor`) ────────────────────────────────
  "correlationId",
  "method",
  "path",
  "statusCode",
  "latencyMs",
  // The account's opaque primary key, and the one identifier here that points
  // at a person. It is allowlisted knowingly: without it no log line can be
  // tied to the account that produced it, which makes an abuse report
  // un-investigable and a "delete my data" request unanswerable. A surrogate
  // key is the cheapest form that carries — it is meaningless outside this
  // database, unlike an email address, which is the same person's identifier at
  // every other service they use.
  "userId",
  // The OpenTelemetry logs data model's names, joined on by the collector.
  "trace_id",
  "span_id",

  // ── Query parameters that are navigation, not data ───────────────────────
  // Named one at a time rather than as `query.*`, which is the difference
  // between this mechanism working and not: `query.*` would have admitted the
  // `code` on the OAuth callback, which is the leak this module was written
  // for. Everything not on this line is redacted, including a parameter added
  // to a DTO next week.
  "query.page",
  "query.limit",
  "query.cursor",
  "query.sort",
  "query.order",
  "query.offset",

  // ── Errors ───────────────────────────────────────────────────────────────
  // The exception's class, which is a programmer's word and the field an
  // operator groups failures by.
  "errorType",
  // The stack, allowlisted knowingly and after weighing it. A Node stack is
  // file paths and function names — code structure, not data — and it is the
  // single most useful field on an error record; redacting every one of them
  // buys very little and costs enough that the whole control gets switched off,
  // which is the outcome worth avoiding. It admits nothing the line does not
  // already carry, either: `err.stack` opens with `${name}: ${message}`, and
  // the message is deliberately kept and scrubbed in the message slot.
  //
  // It is still scrubbed like any other allowlisted string, which matters —
  // a driver that interpolates a connection string into an error puts a
  // password in the first line of the stack.
  "stack",

  // ── Operational fields ───────────────────────────────────────────────────
  // Shapes and counts rather than contents: how much, how long, which class,
  // which outcome. None of them can carry a person unless somebody puts one
  // there, and each is load-bearing for an operator reading a failure.
  "durationMs",
  "attempt",
  "count",
  "queueDepth",
  "eventType",
  "outcome",
] as const;

/**
 * Compiles patterns into an allowlist.
 *
 * Unparseable patterns are **dropped and returned**, never ignored: the caller
 * (`envSchema`) turns them into a boot failure naming the entry. An allowlist
 * that silently discards a malformed line is worse than one that rejects it,
 * because the operator goes on believing a field is being logged and the field
 * is not there when they need it.
 */
export function compileAllowlist(patterns: readonly string[]): {
  allowlist: RedactionAllowlist;
  rejected: readonly string[];
} {
  const compiled: { pattern: string; segments: readonly string[] }[] = [];
  const rejected: string[] = [];

  for (const pattern of patterns) {
    const segments = parsePattern(pattern);
    if (segments === undefined) {
      rejected.push(pattern);
      continue;
    }
    compiled.push({ pattern, segments });
  }

  // Bucketed by length, because matching is length-equal: a record with a
  // two-segment path never looks at the single-segment patterns. On the default
  // list that is a handful of comparisons per field rather than all of them.
  const byLength = new Map<number, readonly string[][]>();
  for (const { segments } of compiled) {
    byLength.set(segments.length, [...(byLength.get(segments.length) ?? []), [...segments]]);
  }

  return {
    allowlist: {
      patterns: compiled.map(({ pattern }) => pattern),
      admits: (path) =>
        (byLength.get(path.length) ?? []).some((pattern) => matchesPattern(path, pattern)),
    },
    rejected,
  };
}

/**
 * Whether an operator-supplied pattern is one they are allowed to add.
 *
 * Refuses a pattern whose **first** segment is `*`. `LOG_REDACTION_EXTRA_ALLOWLIST=*`
 * parses perfectly, admits every top-level field of every log record, and reads
 * in a deployment manifest like a configured allowlist rather than like the
 * disabled redactor it actually is. `LOG_REDACTION_ENABLED=false` is the honest
 * way to say that, and it is refused in production for reasons of its own — so
 * this closes the spelling that would have got around it.
 *
 * A `*` deeper in a pattern is allowed: `counts.*` admits the values under a map
 * whose keys are event names, which no fixed list can express.
 */
export function isPermittedOperatorPattern(pattern: string): boolean {
  const segments = parsePattern(pattern);
  return segments !== undefined && segments[0] !== WILDCARD_SEGMENT;
}
