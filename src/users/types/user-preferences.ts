/**
 * Declared as a type alias rather than an interface on purpose: only type
 * aliases get an implicit index signature, which is what makes this assignable
 * to Prisma's `InputJsonValue` when persisting to the `preferences` JSON column.
 */
export type UserPreferences = {
  theme: "light" | "dark" | "system";
  language: string;
  emailNotifications: boolean;
  pushNotifications: boolean;
  timezone: string;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: "system",
  language: "en",
  emailNotifications: true,
  pushNotifications: false,
  timezone: "UTC",
};
