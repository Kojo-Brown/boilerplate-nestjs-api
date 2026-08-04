import { ForbiddenException, Injectable } from "@nestjs/common";

/**
 * The subset of the authenticated principal this policy needs.
 *
 * Declared here rather than imported from `AuthenticatedUser` so the users
 * module does not depend on the auth module's token shape (DIP). Any
 * authenticated user structurally satisfies it, so callers still pass
 * `@CurrentUser()` straight through.
 */
export interface RequesterIdentity {
  readonly id: string;
  readonly role: string;
}

/**
 * Actions on a user resource that only the owner — or an admin — may perform.
 * The keys drive the denial message so that the wording lives in one place
 * instead of being retyped at every call site.
 */
export type UserOwnedAction =
  "update:profile" | "update:avatar" | "read:preferences" | "update:preferences";

const DENIAL_MESSAGE: Record<UserOwnedAction, string> = {
  "update:profile": "Cannot modify another user's profile",
  "update:avatar": "Cannot modify another user's avatar",
  "read:preferences": "Cannot read another user's preferences",
  "update:preferences": "Cannot modify another user's preferences",
};

const ADMIN_ROLE = "ADMIN";

/**
 * Ownership rules for user-scoped resources.
 *
 * Extracted from `UsersService` (SRP): the service had two reasons to change —
 * how user data is fetched and cached, and who is allowed to touch it — and
 * the ownership check itself was copied into four call sites, one of them in
 * the controller, where it had drifted to its own message. Role checks that
 * do not depend on the *target* stay in `RolesGuard`; this covers only the
 * "is it yours?" half, which a guard cannot answer without the resource id.
 */
@Injectable()
export class UserAccessPolicy {
  /** True when the requester owns the target user or is an admin. */
  canAct(requester: RequesterIdentity, targetUserId: string): boolean {
    return requester.id === targetUserId || requester.role === ADMIN_ROLE;
  }

  /** Throws `ForbiddenException` unless {@link canAct} allows it. */
  assertCanAct(requester: RequesterIdentity, targetUserId: string, action: UserOwnedAction): void {
    if (!this.canAct(requester, targetUserId)) {
      throw new ForbiddenException(DENIAL_MESSAGE[action]);
    }
  }
}
