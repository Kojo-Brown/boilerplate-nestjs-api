import type { LogLevel } from "@nestjs/common";
import type { LogEvent } from "./log-event";

/**
 * Turns a `LoggerService` call into a {@link LogEvent}.
 *
 * Nest's logger interface is `(message: any, ...optionalParams: any[])`, which
 * is a formatting API rather than a structured one — so this is where the
 * variadic call shape is resolved into named parts exactly once, for every call
 * site in the application. Doing it anywhere else would mean a second
 * interpretation of the same arguments, free to disagree about which of them is
 * the context.
 *
 * Three shapes arrive in practice:
 *
 *   * `log("message")` and `log("message", "Context")` — the overwhelming
 *     majority, from `new Logger(SomeClass.name)`.
 *   * `log({ message: "…", …fields })` — the structured call. An object as the
 *     first argument is read as the fields, with `message` lifted out of it.
 *     This is the form worth writing: the allowlist can only reason about
 *     fields, so a value passed this way is one the redactor can see.
 *   * `error(err)` and `error("message", stack, "Context")` — Nest's error
 *     shape, where the argument before the context is a stack trace.
 */
export function toLogEvent(
  level: LogLevel,
  message: unknown,
  optionalParams: readonly unknown[],
): LogEvent {
  const params = [...optionalParams];

  // Nest's convention is that the logger's context is the *last* argument, and
  // only when it is a string. Popping it before anything else is read is what
  // keeps `[OutboxRelay]` out of the message body — the defect the previous
  // implementation described as turning every record into
  // `"message,OutboxRelay"`.
  const context = typeof params.at(-1) === "string" ? (params.pop() as string) : undefined;

  // Nest's error shape is `(message, stack, context)`, and `ConsoleLogger` reads
  // the second argument as the stack when it is a string. Naming it here rather
  // than leaving it in `extra` is what lets the allowlist admit a stack — which
  // it does, deliberately — instead of redacting the most useful field on an
  // error record. It is the convention, not a guess at the string's contents.
  const stack =
    (level === "error" || level === "fatal") && typeof params.at(-1) === "string"
      ? (params.pop() as string)
      : undefined;

  if (isPlainRecord(message)) {
    const { message: embedded, ...rest } = message;
    return {
      level,
      message: typeof embedded === "string" ? embedded : "",
      context,
      fields: {
        ...rest,
        ...(stack === undefined ? {} : { stack }),
        // Extra positional arguments alongside a structured call are a mistake at
        // the call site rather than data, but they are still somebody's bytes, so
        // they go into a field where the allowlist redacts them rather than into
        // the message, which it cannot.
        ...(params.length > 0 ? { extra: params } : {}),
      },
    };
  }

  const fields: Record<string, unknown> = {};
  if (stack !== undefined) fields["stack"] = stack;

  if (message instanceof Error) {
    // Split rather than joined, because the two halves have different
    // exposures. The class name is a programmer's word and belongs in a field
    // an operator can group by; the message quotes whatever caused the failure
    // and therefore cannot be trusted, so it goes to the message slot where it
    // is scrubbed — and where `docs/log-redaction.md` warns it is not
    // allowlisted. The stack is a field, so it is redacted unless allowlisted:
    // a stack is usually file paths and usually safe, and "usually" is not the
    // standard this module applies by default.
    fields["errorType"] = message.constructor.name;
    if (message.stack !== undefined) fields["stack"] = message.stack;
    return { level, message: message.message, context, fields };
  }

  if (params.length > 0) fields["extra"] = params;

  return {
    level,
    // `String()` only for a primitive. An object in the message slot that is not
    // a plain record — a class instance, a Map — is named by type and not
    // stringified: its `toString` is code this module does not own, and the
    // usual result is `[object Object]` while the bad one is the entity itself.
    message: renderMessage(message, fields),
    context,
    fields,
  };
}

function renderMessage(message: unknown, fields: Record<string, unknown>): string {
  if (typeof message === "string") return message;
  if (message === null || message === undefined) return "";
  if (typeof message === "object") {
    // Into a field, so the allowlist decides. The message says what happened
    // without quoting it.
    fields["messageObject"] = message;
    return `<${message.constructor?.name ?? "object"}>`;
  }
  // A number, boolean, bigint or symbol. `String()` on each of these is total
  // and produces exactly what the caller meant.
  return typeof message === "symbol" ? message.toString() : String(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
