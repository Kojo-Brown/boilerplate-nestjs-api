import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { isTenantId } from "@/tenancy/tenant-context";

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  /**
   * The tenant this token was issued for and may be used in.
   *
   * Short, and named like the registered claims beside it (`sub`, `iat`) rather
   * than `tenantId`, because it travels in every `Authorization` header this API
   * ever sees.
   *
   * Optional in the type and required at runtime, which is not a contradiction:
   * the type describes a claim set that has been *verified* but not yet checked,
   * and a token minted before tenancy existed has no `tid`. `validate` refuses
   * those rather than defaulting them into a tenant — a credential that does not
   * say which customer it belongs to is a credential nothing should guess about.
   * The cost is bounded and visible: access tokens live fifteen minutes, so an
   * upgrade produces at most one refresh per client. See docs/multi-tenancy.md.
   */
  tid?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  /** The tenant the token was issued for. See {@link JwtPayload.tid}. */
  tenantId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>("JWT_SECRET"),
      ignoreExpiration: false,
    });
  }

  /**
   * What this does check is that the token names *a* tenant. What it cannot check
   * is whether that is the tenant the request is addressing: Passport hands this
   * method the claim set and not the request. `TenantGuard` makes that comparison
   * one guard later, where it can answer 403 rather than the 401 everything thrown
   * from here is flattened into by `JwtAuthGuard.handleRequest`.
   */
  validate(payload: JwtPayload): AuthenticatedUser {
    const tenantId = payload.tid;
    if (tenantId === undefined || !isTenantId(tenantId)) {
      throw new UnauthorizedException(
        "This access token does not name a tenant. Refresh it — tokens minted before " +
          "multi-tenancy carry no `tid` claim and cannot be scoped to a tenant.",
      );
    }

    return { id: payload.sub, email: payload.email, role: payload.role, tenantId };
  }
}
