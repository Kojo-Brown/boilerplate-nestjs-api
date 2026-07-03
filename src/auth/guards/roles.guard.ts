import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@prisma/client";
import type { Request } from "express";
import { ROLES_KEY } from "@/common/decorators/roles.decorator";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Access denied");
    if (!requiredRoles.includes(user.role as Role)) {
      throw new ForbiddenException(`Role '${user.role}' is not permitted for this resource`);
    }
    return true;
  }
}
