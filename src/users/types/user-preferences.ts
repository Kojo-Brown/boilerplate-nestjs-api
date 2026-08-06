/**
 * Declared as a type alias rather than an interface on purpose: only type
 * aliases get an implicit index signature, which is what makes this assignable
 * to Prisma's `InputJsonValue` when persisting to the `preferences` JSON column.
 */
export type UserPreferences = {
  theme: "light" | "dark" | "system";
  language: string;
  emailNotifications: boolean;
  smsNotifications: boolean;
  pushNotifications: boolean;
  timezone: string;
};

/**
 * Applies a partial update on top of stored preferences.
 *
 * The `definedOnly` filter is the whole point, and it is not defensive
 * programming. A patch arrives as an `UpdateUserPreferencesDto` *instance*, and
 * under `target: ES2022` class fields are defined on construction — so a body
 * of `{ "smsNotifications": true }` produces an object with all six keys, five
 * of them `undefined`. A plain `{ ...current, ...patch }` therefore overwrites
 * every untouched preference with `undefined`: changing one setting silently
 * discarded the other five, and the next read got `undefined` rather than even
 * the default, which reads as "off" for a notification channel.
 *
 * Both stores merge through here so the Prisma adapter and the in-memory one
 * cannot drift on it.
 */
export function mergePreferences(
  current: UserPreferences,
  patch: Partial<UserPreferences>,
): UserPreferences {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<UserPreferences>;

  return { ...current, ...defined };
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: "system",
  language: "en",
  emailNotifications: true,
  // Off by default: an SMS costs money and needs a phone number the account
  // does not have until the user supplies one.
  smsNotifications: false,
  pushNotifications: false,
  timezone: "UTC",
};
