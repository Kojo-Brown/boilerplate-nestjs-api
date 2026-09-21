import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { authorizePeer, describeConnection } from "./peer-authorization";
import type { PeerPolicy } from "./peer-authorization";
import { mtlsEnvFrom, parseAllowedClients, parseExemptPrefixes } from "./mtls.env";

/**
 * Refuses a request whose peer is not one this service takes calls from.
 *
 * Bound globally by {@link MtlsModule}, and a pass-through when `MTLS_ENABLED`
 * is off — which is what lets it be registered unconditionally rather than
 * built into a conditional module graph.
 *
 * **Why a guard rather than middleware.** A `ForbiddenException` raised here
 * goes through `AllExceptionsFilter` and comes back as this API's error
 * envelope with its correlation id, like every other refusal. Express
 * middleware bound with `app.use` runs before Nest's router, so an error it
 * raises reaches Express's default handler instead: an HTML page, a 500, and no
 * correlation id — for a decision that a caller's operator has to be able to
 * read.
 *
 * **Why it still matters when `rejectUnauthorized` is on.** With the default
 * TLS options this guard should never see an unauthenticated connection,
 * because OpenSSL ends those in the handshake. It checks anyway: it is the only
 * thing standing between the exempt-path setting and an open door, and
 * `MTLS_ALLOW_UNAUTHENTICATED_PROBES` moves the whole decision here.
 */
@Injectable()
export class MtlsPeerGuard implements CanActivate {
  private readonly logger = new Logger(MtlsPeerGuard.name);
  private readonly enabled: boolean;
  private readonly policy: PeerPolicy;

  constructor(config: ConfigService) {
    const env = mtlsEnvFrom(config);
    this.enabled = env.MTLS_ENABLED;
    this.policy = {
      allowlist: parseAllowedClients(env),
      exemptPrefixes: parseExemptPrefixes(env),
    };
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled) return true;

    // WebSocket and microservice contexts have no `Request`. The realtime
    // gateway shares this process's TLS listener, so its connection was already
    // authenticated in the same handshake; there is no second decision to make
    // here, and reading an HTTP request off a non-HTTP context would throw.
    if (context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<Request>();
    const decision = authorizePeer(describeConnection(request.socket), request.path, this.policy);

    if (decision.allowed) return true;

    this.logger.warn(
      `Refused ${request.method} ${request.path}: ${decision.reason}. ${decision.detail}`,
    );
    // The message names the identity that was presented rather than the ones
    // that are allowed: the caller already knows who it is, and the allowlist
    // is this service's business. The full comparison is in the log line above.
    throw new ForbiddenException(
      `This service requires a client certificate from a known peer (${decision.reason}).`,
    );
  }
}
