import { ForbiddenException } from "@nestjs/common";
import { UserAccessPolicy } from "./users.access-policy";
import type { UserOwnedAction } from "./users.access-policy";

describe("UserAccessPolicy", () => {
  const policy = new UserAccessPolicy();
  const owner = { id: "user-1", role: "USER" };
  const stranger = { id: "user-2", role: "USER" };
  const admin = { id: "admin-1", role: "ADMIN" };

  describe("canAct()", () => {
    it("allows the owner", () => {
      expect(policy.canAct(owner, "user-1")).toBe(true);
    });

    it("allows an admin acting on someone else", () => {
      expect(policy.canAct(admin, "user-1")).toBe(true);
    });

    it("denies a different non-admin user", () => {
      expect(policy.canAct(stranger, "user-1")).toBe(false);
    });

    it("does not treat an unknown role as privileged", () => {
      expect(policy.canAct({ id: "user-2", role: "SUPERUSER" }, "user-1")).toBe(false);
      expect(policy.canAct({ id: "user-2", role: "admin" }, "user-1")).toBe(false);
    });
  });

  describe("assertCanAct()", () => {
    it("returns silently when allowed", () => {
      expect(() => policy.assertCanAct(owner, "user-1", "update:profile")).not.toThrow();
    });

    it.each<[UserOwnedAction, string]>([
      ["update:profile", "Cannot modify another user's profile"],
      ["update:avatar", "Cannot modify another user's avatar"],
      ["read:preferences", "Cannot read another user's preferences"],
      ["update:preferences", "Cannot modify another user's preferences"],
    ])("throws Forbidden with the %s message", (action, message) => {
      expect(() => policy.assertCanAct(stranger, "user-1", action)).toThrow(ForbiddenException);
      expect(() => policy.assertCanAct(stranger, "user-1", action)).toThrow(message);
    });
  });
});
