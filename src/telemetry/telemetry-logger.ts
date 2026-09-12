import { ConsoleLogger, type LogLevel, type LoggerService } from "@nestjs/common";
import { SeverityNumber, logs, type Logger as OtelLogger } from "@opentelemetry/api-logs";

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

  constructor(context?: string) {
    this.console = context === undefined ? new ConsoleLogger() : new ConsoleLogger(context);
    // Resolved once. `logs.getLogger` reads the global provider on each call,
    // and the provider is installed before this class is constructed — see
    // `telemetry/register.ts`, which runs before `main.ts` builds anything.
    this.otel = logs.getLogger("nestjs");
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.console.log(message, ...optionalParams);
    this.emit("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.console.error(message, ...optionalParams);
    this.emit("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.console.warn(message, ...optionalParams);
    this.emit("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.console.debug(message, ...optionalParams);
    this.emit("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.console.verbose(message, ...optionalParams);
    this.emit("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.console.fatal(message, ...optionalParams);
    this.emit("fatal", message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.console.setLogLevels(levels);
  }

  /**
   * One log record, with the Nest logger's trailing `context` argument lifted
   * out into an attribute.
   *
   * Nest passes the logger's context as the last argument — `this.logger.log(
   * "…", "OutboxRelay")` — and an `error` carries a stack in front of it. Left
   * in the body, that trailing string turns every record into
   * `"message,OutboxRelay"`, which is neither the message nor a field anything
   * can group by.
   */
  private emit(level: LogLevel, message: unknown, optionalParams: readonly unknown[]): void {
    const severity = SEVERITY[level];
    const params = [...optionalParams];
    const context = typeof params.at(-1) === "string" ? (params.pop() as string) : undefined;

    const attributes: Record<string, string> = {};
    if (context !== undefined) attributes["log.context"] = context;
    // Whatever is left is a stack trace or an extra argument. Joined rather
    // than dropped: for `error` it is the stack, which is the most useful part
    // of the record.
    if (params.length > 0) attributes["log.extra"] = params.map(stringify).join("\n");

    this.otel.emit({
      severityNumber: severity.number,
      severityText: severity.text,
      body: stringify(message),
      attributes,
    });
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A cycle, or a BigInt. The message is still worth having.
    return String(value);
  }
}
