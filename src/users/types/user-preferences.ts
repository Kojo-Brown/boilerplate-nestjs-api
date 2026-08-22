import { deepFreeze, patch } from "@/common/immutable";
import type { DeepReadonly } from "@/common/immutable";

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
 * How preferences are handed *out*.
 *
 * A value that leaves a store may be one the store is still holding —
 * {@link mergePreferences} returns its input unchanged when a patch changes
 * nothing — so the reader must not be able to write to it. See
 * [docs/immutability.md](../../../docs/immutability.md).
 */
export type ReadonlyUserPreferences = DeepReadonly<UserPreferences>;

/**
 * Applies a partial update on top of stored preferences.
 *
 * Delegates to `patch`, whose defined-keys-only rule is the whole point and is
 * not defensive programming. A patch arrives as an `UpdateUserPreferencesDto`
 * *instance*, and under `target: ES2022` class fields are defined on
 * construction — so a body of `{ "smsNotifications": true }` produces an object
 * with all six keys, five of them `undefined`. A plain `{ ...current, ...patch }`
 * therefore overwrites every untouched preference with `undefined`: changing one
 * setting silently discarded the other five, and the next read got `undefined`
 * rather than even the default, which reads as "off" for a notification channel.
 *
 * Both stores merge through here so the Prisma adapter and the in-memory one
 * cannot drift on it.
 *
 * Structural sharing adds one guarantee on top: a patch that asks for the state
 * the preferences are already in returns `current` *itself*, so a caller can
 * tell a real change from a no-op with `!==` rather than a deep comparison.
 * That is also why the result is `ReadonlyUserPreferences` — the returned value
 * may be the store's own, or {@link DEFAULT_USER_PREFERENCES}.
 */
export function mergePreferences(
  current: ReadonlyUserPreferences,
  changes: Partial<UserPreferences>,
): ReadonlyUserPreferences {
  return patch(current, changes);
}

/**
 * Frozen unconditionally, not only outside production.
 *
 * Request-payload freezing is a development guard that trades cost for early
 * failure, but this is one object frozen once at module load, and it is shared
 * by every user who has never set a preference: `mergePreferences(DEFAULT, {})`
 * returns *this object*, not a copy. A single caller mutating what it thinks is
 * its own copy would change the defaults for everyone, which is exactly the
 * hazard structural sharing introduces and freezing removes — so it is removed
 * in every environment.
 */
export const DEFAULT_USER_PREFERENCES: ReadonlyUserPreferences = deepFreeze<UserPreferences>({
  theme: "system",
  language: "en",
  emailNotifications: true,
  // Off by default: an SMS costs money and needs a phone number the account
  // does not have until the user supplies one.
  smsNotifications: false,
  pushNotifications: false,
  timezone: "UTC",
});
