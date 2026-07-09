export interface UserPreferences {
  theme: "light" | "dark" | "system";
  language: string;
  emailNotifications: boolean;
  pushNotifications: boolean;
  timezone: string;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: "system",
  language: "en",
  emailNotifications: true,
  pushNotifications: false,
  timezone: "UTC",
};
