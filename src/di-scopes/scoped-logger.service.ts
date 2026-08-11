import { Inject, Injectable, Logger, Optional, Scope } from "@nestjs/common";
import { INQUIRER } from "@nestjs/core";
import { InstantiationLedger } from "./instantiation-ledger.service";

/**
 * A logger that knows which class it was injected into — the canonical reason
 * to reach for `Scope.TRANSIENT`.
 *
 * Transient means "a private instance per consumer", not "a new instance per
 * request". A transient injected into a singleton is constructed once, at
 * boot, and lives as long as its host; a transient injected into a
 * request-scoped provider is constructed once per request, because its *host*
 * is. The scope decides who shares an instance, and it is the host's lifetime
 * that decides how long that instance lasts.
 *
 * `INQUIRER` is what makes the private instance worth having: each one is
 * handed the consumer that asked for it, so it can tag every line with that
 * class's name without the consumer passing its own name in. It is `@Optional`
 * for the case with no consumer to name — a unit test calling the constructor
 * directly. (`moduleRef.resolve()` is not that case: Nest hands a directly
 * resolved transient its own wrapper, so it comes out named after itself.)
 *
 * Note what this class does *not* do: hold anything request-specific. A
 * transient in a singleton is a singleton by another name, so a correlation id
 * stored here would be the first request's id for the lifetime of the process.
 * That is what {@link RequestContextService} is for.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class ScopedLogger {
  /** The class this instance belongs to, or `"unknown"` if resolved directly. */
  readonly host: string;

  readonly instanceId: string;

  private readonly logger: Logger;

  constructor(
    ledger: InstantiationLedger,
    @Optional() @Inject(INQUIRER) inquirer?: object | string,
  ) {
    this.host = hostNameOf(inquirer);
    this.instanceId = ledger.record(ScopedLogger.name);
    this.logger = new Logger(this.host);
  }

  log(message: string): void {
    this.logger.log(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  debug(message: string): void {
    this.logger.debug(message);
  }
}

/**
 * `INQUIRER` is the consuming *instance* when the host is a class provider and
 * the host's token when it is not — a string or symbol token bound with
 * `useFactory`, say. Both shapes are named here rather than only the common
 * one, because a `"[object Object]"` in a log line is the kind of defect that
 * survives for years.
 */
function hostNameOf(inquirer: object | string | undefined): string {
  if (typeof inquirer === "string") return inquirer;
  if (inquirer && typeof inquirer === "object") {
    const name: unknown = inquirer.constructor?.name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "unknown";
}
