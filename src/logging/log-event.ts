import type { LogLevel } from "@nestjs/common";

/**
 * One log line, before it has been rendered — structlog's `event_dict`.
 *
 * The shape is what makes redaction possible at all. A logger whose only input
 * is a formatted string can be filtered but not understood: `"user a@b.com
 * placed order 7"` has no field boundaries, so anything walking it is reduced
 * to guessing at substrings. Splitting the line into a free-text {@link message}
 * and a map of named {@link fields} is what lets the allowlist make a decision
 * per field instead of per character.
 *
 * The consequence — and it is the central caveat of this whole mechanism — is
 * that the two halves are protected by *different* strengths. `fields` is
 * gated by an allowlist, so a field nobody has thought about is redacted.
 * `message` cannot be: it is one string, it is the one part of the line that
 * must survive for the line to be worth keeping, and there is no key to look
 * up. It gets the credential scrubber and nothing more. So a value interpolated
 * into a message is a value that ships.
 *
 * That is the reason to log `{ message: "order placed", customerEmail: … }`
 * rather than `` `order placed for ${email}` ``, and `docs/log-redaction.md`
 * says so in those words.
 */
export interface LogEvent {
  readonly level: LogLevel;
  /**
   * The human-readable part. Scrubbed for credentials, never allowlisted —
   * see the note above.
   */
  readonly message: string;
  /**
   * Nest's logger context: the `[OutboxRelay]` in its console output, and
   * `log.context` on the OpenTelemetry record.
   *
   * Not a field, because it is not data: it is the name of the class that
   * logged, chosen by a developer, and redacting it would cost every line its
   * only grouping key.
   */
  readonly context?: string;
  /** The structured half, subject to the allowlist. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * What replaces a value the allowlist did not admit.
 *
 * The key is kept and only the value is replaced, which is the whole point: an
 * operator reading `{"customerEmail":"[redacted]"}` learns that the field
 * exists, that it was populated, and that it is not allowlisted — three things
 * that make the next change obvious. Dropping the key instead would leave a
 * line that looks complete and is not, and the difference between "no email
 * was involved" and "an email was involved and you may not see it" is exactly
 * the difference an incident turns on.
 *
 * Deliberately carries no length, no hash and no prefix of the original. A
 * redacted value's length is a real help to anyone guessing at it, and a stable
 * hash of a low-cardinality field — a postcode, a date of birth, a national
 * identifier — is reversible by enumeration, so both would quietly re-introduce
 * what this replaces. Correlating two occurrences of one value is what
 * `userId` is allowlisted for.
 */
export const REDACTED = "[redacted]";

/** Marks a value omitted because a structural cap was hit, not because of the allowlist. */
export const TRUNCATED = "[truncated]";
