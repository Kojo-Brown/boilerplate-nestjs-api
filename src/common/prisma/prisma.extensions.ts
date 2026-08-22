import { Prisma } from "@prisma/client";
import { DEFAULT_USER_PREFERENCES, mergePreferences } from "@/users/types/user-preferences";
import type { ReadonlyUserPreferences, UserPreferences } from "@/users/types/user-preferences";

export const preferencesExtension = Prisma.defineExtension({
  name: "user-preferences",
  model: {
    user: {
      async getPreferences(id: string): Promise<ReadonlyUserPreferences> {
        const ctx = Prisma.getExtensionContext(this);
        const user = await ctx.findUnique({
          where: { id },
          select: { preferences: true },
        });
        const stored = (user?.preferences ?? null) as Partial<UserPreferences> | null;
        return mergePreferences(DEFAULT_USER_PREFERENCES, stored ?? {});
      },

      /**
       * `versionFilter` is spread into the `where` of the write, so a caller
       * that supplies one turns this read-modify-write into a compare-and-set:
       * two concurrent patches both read version 5, both write `WHERE id = …
       * AND version = 5`, and the second matches no row instead of quietly
       * overwriting the first. Without one the interleaving still loses a
       * write — which is why `PrismaUsersRepository` always passes it.
       *
       * It is a plain Prisma filter rather than an `ExpectedVersion` on
       * purpose: an extension is Prisma vocabulary, and teaching it the HTTP
       * layer's value type would put `If-Match` semantics one import away from
       * the query builder.
       */
      async setPreferences(
        id: string,
        patch: Partial<UserPreferences>,
        versionFilter: Prisma.IntFilter | undefined = undefined,
      ): Promise<{ preferences: ReadonlyUserPreferences; version: number }> {
        const ctx = Prisma.getExtensionContext(this);
        const user = await ctx.findUnique({
          where: { id },
          select: { preferences: true },
        });
        if (!user) throw new Error(`User ${id} not found`);
        const current = mergePreferences(
          DEFAULT_USER_PREFERENCES,
          (user.preferences as Partial<UserPreferences> | null) ?? {},
        );
        const updated = mergePreferences(current, patch);
        const written = await ctx.update({
          where: versionFilter ? { id, version: versionFilter } : { id },
          data: { preferences: updated, version: { increment: 1 } },
          select: { version: true },
        });
        return { preferences: updated, version: written.version };
      },
    },
  },
});
