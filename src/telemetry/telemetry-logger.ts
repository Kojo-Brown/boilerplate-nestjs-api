import { ConsoleLogger, type LogLevel, type LoggerService } from "@nestjs/common";
import { SeverityNumber, logs, type Logger as OtelLogger } from "@opentelemetry/api-logs";
import {
  defaultProcessors,
  renderFields,
  runProcessors,
  toLogEvent,
  type LogEvent,
  type LogProcessor,
} from "@/logging";

/** Nest's six levels, mapped onto the severities the logs data model defines. */
const SEVERITY: Readonly<Record<LogLevel, { number: SeverityNumber; text: string }>> = {
  verbose: { number: SeverityNumber.TRACE, text: "TRACE" },
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  log: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
  fatal: { number: SeverityNumber.FATAL, text: "FATAL" },
};

/**
 * The application logger: stdout, plus the OpenTelemetry logs pipeline.
 *
 * ### Why both, and not one or the other
 *
 * Writing only to stdout is the status quo and leaves the third pillar to a
 * sidecar that scrapes text back into structure — which works until a log line
 * contains a newline, and which has no access to the trace context that makes a
 * log line worth finding. Writing only to the pipeline would mean a service
 * whose logs vanish the moment the collector is unreachable, and an operator
 * with no `kubectl logs`. So: stdout is the durable copy, the pipeline is the
 * queryable one.
 *
 * ### Why the redaction lives here
 *
 * Because this is the only seam every log line passes through. `app.useLogger()`
 * installs this class as the application logger, and a `new Logger()` anywhere
 * in the codebase delegates to it — so a processor chain applied here cannot be
 * bypassed by a call site that has not heard of it, which is the property any
 * redaction mechanism needs and the reason not to put it in an interceptor. It
 * runs before *both* sinks: see {@link TelemetryLogger.write} and
 * `docs/log-redaction.md`.
 *
 * ### Why the trace ids are not added here
 *
 * A `LogRecord` emitted without an explicit context takes the active one, and
 * the logs SDK stamps `trace_id`, `span_id` and `trace_flags` on it from there.
 * Reading the span context in this file and setting the attributes by hand
 * would produce the same three fields under names of our own invention, which
 * no backend would join on.
 *
 * The access log is the exception and does it explicitly — see
 * `LoggingInterceptor` — because that line goes to stdout as JSON and has to
 * carry the ids *in its body* for a text-scraping collector to find them.
 *
 * ### Why it is safe to install unconditionally
 *
 * With telemetry off, `logs.getLogger()` returns the API's no-op logger and
 * `emit` is an empty method. The class then behaves exactly like the
 * `ConsoleLogger` Nest installs by default, which is why `main.ts` does not
 * branch on whether the SDK started.
 *
 * Composition rather than `extends ConsoleLogger`: the base class's methods are
 * overloaded and typed in terms of `any`, and overriding them would mean either
 * reproducing the overloads or reaching for the `any` this repository does not
 * allow. Delegating keeps every parameter `unknown` on this side of the seam.
 */
export class TelemetryLogger implements LoggerService {
  private readonly console: ConsoleLogger;
  private readonly otel: OtelLogger;
  private readonly processors: readonly LogProcessor[];

  constructor(context?: string, processors: readonly LogProcessor[] = defaultProcessors()) {
    this.console = context === undefined ? new ConsoleLogger() : new ConsoleLogger(context);
    // Resolved once. `logs.getLogger` reads the global provider on each call,
    // and the provider is installed before this class is constructed — see
    // `telemetry/register.ts`, which runs before `main.ts` builds anything.
    this.otel = logs.getLogger("nestjs");
    // Injectable so a spec can hand in a chain of its own, defaulted from the
    // environment so no call site has to remember to. Every `new Logger()` in
    // the application funnels through the app logger Nest installs, so the
    // default is what almost everything gets and it must be the safe one.
    this.processors = processors;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.console.setLogLevels(levels);
  }

  /**
   * The one place a log line is turned into output.
   *
   * The processors run **before either sink**, which is the correctness
   * requirement that shapes this method. Redacting only the OpenTelemetry record
   * would leave the stdout copy — the one an operator reads with `kubectl logs`,
   * the one that is scraped into whatever the cluster keeps, and the copy that
   * exists even when the collector is unreachable — in the clear. Two sinks with
   * two different ideas of what is sensitive is the same as having no redaction
   * at all, and it would be the harder version to notice, because the pipeline
   * an auditor is shown would look correct.
   *
   * A dropped record writes nothing to either sink. That is what makes a
   * sampling or rate-limiting processor mean anything.
   */
  private write(level: LogLevel, message: unknown, optionalParams: readonly unknown[]): void {
    const processed = runProcessors(
      this.processors,
      toLogEvent(level, message, optionalParams),
      // Reported to stderr directly, not through this logger: a processor that
      // throws on every record would make a logged report recurse until the
      // stack ran out, and the failure substitute already reaches both sinks by
      // the normal path. This is the second copy, for the case where the logging
      // pipeline itself is what is broken.
      (error) => {
        process.stderr.write(
          `TelemetryLogger: a log processor threw; record content withheld (${errorLabel(error)})\n`,
        );
      },
    );
    if (processed === null) return;

    this.writeToConsole(processed);
    this.emit(processed);
  }

  /**
   * The stdout copy, through Nest's own formatter.
   *
   * The fields are appended as JSON rather than passed to `ConsoleLogger` as an
   * object, because `ConsoleLogger` pretty-prints an object over several lines
   * and a log line that spans lines is the exact failure `docs/telemetry.md`
   * gives as the reason not to rely on scraping text. One line per record keeps
   * both readers working: a person, and whatever is tailing the file.
   */
  private writeToConsole(event: LogEvent): void {
    const fields = renderFields(event);
    const text = fields === undefined ? event.message : `${event.message} ${fields}`;
    // `ConsoleLogger` reads a trailing string argument as the context, which is
    // what prints the `[OutboxRelay]` tag — so it is passed positionally rather
    // than folded into the text.
    if (event.context === undefined) this.console[CONSOLE_METHOD[event.level]](text);
    else this.console[CONSOLE_METHOD[event.level]](text, event.context);
  }

  /**
   * One OpenTelemetry log record.
   *
   * The fields go on as attributes, one per field, rather than as a JSON blob in
   * the body: an attribute is what a backend can filter and group by, and
   * `attributes["fields"] = "{…}"` would make every query a substring search.
   * The body stays the message, which is the logs data model's intent.
   */
  private emit(event: LogEvent): void {
    const severity = SEVERITY[event.level];
    const attributes: Record<string, string | number | boolean> = {};
    if (event.context !== undefined) attributes["log.context"] = event.context;
    for (const [key, value] of Object.entries(event.fields)) {
      attributes[key] = attributeValue(value);
    }

    this.otel.emit({
      severityNumber: severity.number,
      severityText: severity.text,
      body: event.message,
      attributes,
    });
  }
}

/** Nest's level names to `ConsoleLogger`'s methods. */
const CONSOLE_METHOD: Readonly<
  Record<LogLevel, "log" | "error" | "warn" | "debug" | "verbose" | "fatal">
> = {
  verbose: "verbose",
  debug: "debug",
  log: "log",
  warn: "warn",
  error: "error",
  fatal: "fatal",
};

/**
 * Flattens a redacted field for the attribute map.
 *
 * The logs data model's attribute values are scalars and homogeneous arrays, so
 * a nested object has to become a string somewhere. It happens here, after
 * redaction, which is the only ordering that is safe: serialising first and
 * redacting the string afterwards would leave the walker nothing to walk and put
 * the whole structure back under the pattern scrubber it is not strong enough
 * for.
 */
function attributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserialisable]";
  }
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
