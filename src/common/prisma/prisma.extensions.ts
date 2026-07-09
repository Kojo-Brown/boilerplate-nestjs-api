import { Prisma } from "@prisma/client";
import { DEFAULT_USER_PREFERENCES } from "@/users/types/user-preferences";
import type { UserPreferences } from "@/users/types/user-preferences";

export const preferencesExtension = Prisma.defineExtension({
  name: "user-preferences",
  model: {
    user: {
      async getPreferences(id: string): Promise<UserPreferences> {
        const ctx = Prisma.getExtensionContext(this);
        const user = await ctx.findUnique({
          where: { id },
          select: { preferences: true },
        });
        const stored = (user?.preferences ?? null) as Partial<UserPreferences> | null;
        return { ...DEFAULT_USER_PREFERENCES, ...(stored ?? {}) };
      },

      async setPreferences(
        id: string,
        patch: Partial<UserPreferences>,
      ): Promise<UserPreferences> {
        const ctx = Prisma.getExtensionContext(this);
        const user = await ctx.findUnique({
          where: { id },
          select: { preferences: true },
        });
        if (!user) throw new Error(`User ${id} not found`);
        const current: UserPreferences = {
          ...DEFAULT_USER_PREFERENCES,
          ...((user.preferences as Partial<UserPreferences> | null) ?? {}),
        };
        const updated: UserPreferences = { ...current, ...patch };
        await ctx.update({
          where: { id },
          data: { preferences: updated as Prisma.InputJsonValue },
        });
        return updated;
      },
    },
  },
});
