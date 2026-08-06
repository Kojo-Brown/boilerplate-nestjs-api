import type { UserPreferences } from "@/users/types/user-preferences";
import { NOTIFICATION_CHANNEL_NAMES } from "./ports";
import type { NotificationCategory, NotificationChannelName } from "./ports";

/**
 * Which preference flag governs which channel.
 *
 * Typed as a total record over the channel names, so adding a channel to
 * `NOTIFICATION_CHANNEL_NAMES` without deciding how a user opts out of it is a
 * compile error rather than a channel that quietly ignores preferences. The
 * values are keys of `UserPreferences`, so renaming a preference is a compile
 * error too.
 */
const PREFERENCE_KEY_BY_CHANNEL: Readonly<Record<NotificationChannelName, keyof UserPreferences>> =
  {
    email: "emailNotifications",
    sms: "smsNotifications",
    push: "pushNotifications",
  };

/**
 * The channel a transactional message falls back to when the user has switched
 * everything off.
 *
 * A password reset or a security alert that nobody receives is not a respected
 * preference, it is a support ticket — and for most jurisdictions a
 * transactional message is not the kind of contact a user can opt out of in the
 * first place. So preferences fully govern `marketing`, and govern
 * `transactional` only as long as at least one channel survives them.
 *
 * Email rather than SMS or push because it is the one address every account
 * has: registration requires it, OAuth sign-in supplies it, and unlike a device
 * token it does not expire when someone reinstalls an app.
 */
export const TRANSACTIONAL_FALLBACK_CHANNEL: NotificationChannelName = "email";

/** Whether `preferences` allows this channel, ignoring category and addresses. */
export function isChannelEnabled(
  preferences: UserPreferences,
  channel: NotificationChannelName,
): boolean {
  return preferences[PREFERENCE_KEY_BY_CHANNEL[channel]] === true;
}

/**
 * The channels a user has opted into, in the declared channel order.
 *
 * Pure and free of Nest, so the selection rule can be tested exhaustively
 * against every combination of flags without a module, a store, or a transport
 * in the way. The dispatcher then narrows this by what is configured and what
 * the recipient can actually be reached on.
 */
export function selectChannels(
  preferences: UserPreferences,
  category: NotificationCategory,
): readonly NotificationChannelName[] {
  const enabled = NOTIFICATION_CHANNEL_NAMES.filter((channel) =>
    isChannelEnabled(preferences, channel),
  );

  if (enabled.length > 0 || category !== "transactional") return enabled;

  // Everything is off and the message is one the user cannot opt out of.
  return [TRANSACTIONAL_FALLBACK_CHANNEL];
}
