import { Inject, Injectable, Logger } from "@nestjs/common";
import type { User } from "@prisma/client";
import { USER_PREFERENCES_STORE } from "@/users/ports";
import type { UserPreferencesStore } from "@/users/ports";
import type { UserPreferences } from "@/users/types/user-preferences";
import { selectChannels } from "./notification-preferences";
import { NOTIFICATION_CHANNELS } from "./ports";
import type {
  Notification,
  NotificationChannel,
  NotificationChannelName,
  NotificationDelivery,
  NotificationRecipient,
} from "./ports";

/** Why a channel the user had enabled was not used after all. */
export type SkipReason =
  /** The user has this channel switched off in their preferences. */
  | "preference-disabled"
  /** Registered, but its credentials are missing from the environment. */
  | "not-configured"
  /** Configured, but this recipient has no address it can deliver to. */
  | "no-address"
  /** Attempted and rejected. `error` carries the message. */
  | "failed";

export interface SkippedChannel {
  readonly channel: NotificationChannelName;
  readonly reason: SkipReason;
  /** Present only when `reason` is `failed`. */
  readonly error?: string;
}

/**
 * What happened on every channel, successful or not.
 *
 * Returned rather than thrown-or-void because a notification is not a single
 * operation that succeeded or failed: two channels delivering and one failing
 * is both the common case and something the caller may want to log, retry, or
 * ignore. A `void` return would force that decision into this service.
 */
export interface DispatchReport {
  readonly userId: string;
  readonly delivered: readonly NotificationDelivery[];
  readonly skipped: readonly SkippedChannel[];
}

/**
 * One channel's result, tagged with the channel it came from.
 *
 * A discriminated union rather than an optional `error`, so the branch that
 * reads `delivery` cannot compile without having ruled the failure case out.
 */
type ChannelOutcome =
  | { readonly channel: NotificationChannelName; readonly delivery: NotificationDelivery }
  | { readonly channel: NotificationChannelName; readonly error: string };

/**
 * Chooses delivery channels per user preference and fans a notification out
 * across them — the Context of the Strategy pattern.
 *
 * It holds the {@link NOTIFICATION_CHANNELS} collection and never names a
 * concrete transport, so which strategies exist is decided entirely in
 * `notifications.module.ts`. Selection runs in four stages, each of which can
 * remove a channel and record why:
 *
 *   1. the user's preferences (plus the transactional fallback rule),
 *   2. whether the channel is registered at all,
 *   3. whether it has credentials,
 *   4. whether this recipient has an address it can reach.
 *
 * Surviving channels are attempted concurrently and independently: SMS being
 * down neither stops nor delays the email. Every outcome lands on the report
 * instead of in an exception, so the caller sees "email queued, push failed"
 * rather than one thrown error that hides the half that worked.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly registry: ReadonlyMap<NotificationChannelName, NotificationChannel>;

  constructor(
    @Inject(NOTIFICATION_CHANNELS) channels: readonly NotificationChannel[],
    @Inject(USER_PREFERENCES_STORE) private readonly preferences: UserPreferencesStore,
  ) {
    const registry = new Map<NotificationChannelName, NotificationChannel>();
    for (const channel of channels) {
      if (registry.has(channel.channel)) {
        // Two strategies on one name means one silently shadows the other, and
        // which one wins depends on module registration order. Fail at boot.
        throw new Error(`Duplicate notification channel registered for "${channel.channel}"`);
      }
      registry.set(channel.channel, channel);
    }
    this.registry = registry;
  }

  /** Every registered channel, whether or not it has credentials. */
  get registered(): readonly NotificationChannelName[] {
    return [...this.registry.keys()];
  }

  /** The channels that could actually deliver something right now. */
  get available(): readonly NotificationChannelName[] {
    return [...this.registry.values()]
      .filter((channel) => channel.isConfigured)
      .map((channel) => channel.channel);
  }

  /**
   * Sends `notification` to `recipient` on every channel their preferences
   * allow and that can reach them.
   *
   * Reads preferences from the store on each call rather than taking them as an
   * argument, so a caller cannot accidentally dispatch against stale flags — an
   * unsubscribe that landed a second ago is honoured by the next notification.
   * {@link notifyWith} is there for the caller that has already loaded them.
   */
  async notify(
    recipient: NotificationRecipient,
    notification: Notification,
  ): Promise<DispatchReport> {
    const preferences = await this.preferences.getPreferences(recipient.userId);
    return this.notifyWith(recipient, notification, preferences);
  }

  /** {@link notify} against preferences the caller already holds. */
  async notifyWith(
    recipient: NotificationRecipient,
    notification: Notification,
    preferences: UserPreferences,
  ): Promise<DispatchReport> {
    const chosen = selectChannels(preferences, notification.category);
    const skipped: SkippedChannel[] = [];

    for (const name of this.registered) {
      if (!chosen.includes(name)) skipped.push({ channel: name, reason: "preference-disabled" });
    }

    const eligible: NotificationChannel[] = [];
    for (const name of chosen) {
      const channel = this.registry.get(name);
      if (!channel) {
        // A preference naming a channel nobody registered. Not the user's
        // fault and not worth failing over, but it must not be silent.
        this.logger.warn(`Preferences selected unregistered channel "${name}"`);
        continue;
      }
      if (!channel.isConfigured) {
        skipped.push({ channel: name, reason: "not-configured" });
        continue;
      }
      if (channel.addressFor(recipient) === null) {
        skipped.push({ channel: name, reason: "no-address" });
        continue;
      }
      eligible.push(channel);
    }

    // Each send carries its own channel name and catches its own failure, so
    // no promise passed to `Promise.all` ever rejects: one dead transport
    // cannot abandon the siblings still in flight, and the outcome stays
    // attached to the channel it came from rather than to an array index.
    const results = await Promise.all(
      eligible.map(async (channel): Promise<ChannelOutcome> => {
        try {
          return {
            channel: channel.channel,
            delivery: await channel.send(recipient, notification),
          };
        } catch (caught) {
          const error = caught instanceof Error ? caught.message : String(caught);
          return { channel: channel.channel, error };
        }
      }),
    );

    const delivered: NotificationDelivery[] = [];
    for (const result of results) {
      if ("delivery" in result) {
        delivered.push(result.delivery);
        continue;
      }
      this.logger.warn(
        `Notification to user ${recipient.userId} failed on ${result.channel}: ${result.error}`,
      );
      skipped.push({ channel: result.channel, reason: "failed", error: result.error });
    }

    if (delivered.length === 0) {
      // Worth a log line at every call site's expense: a notification nobody
      // received is invisible otherwise, and the reasons are the whole story.
      this.logger.warn(
        `Notification "${notification.title}" reached user ${recipient.userId} on no channel ` +
          `(${skipped.map((s) => `${s.channel}: ${s.reason}`).join(", ") || "none registered"})`,
      );
    }

    return { userId: recipient.userId, delivered, skipped: sortByChannel(skipped) };
  }
}

/**
 * Builds a recipient from a user row plus whatever addresses the caller holds.
 *
 * The `User` model stores an email address and nothing else — there is no
 * `phone` column and no device-token table — so SMS and push addresses have to
 * come from the caller until one exists. Funnelling that through one function
 * keeps the gap in a single documented place instead of at every call site, and
 * makes adding the columns later a change here rather than everywhere.
 */
export function recipientFromUser(
  user: Pick<User, "id" | "email">,
  contact: Omit<NotificationRecipient, "userId" | "email"> = {},
): NotificationRecipient {
  return { userId: user.id, email: user.email, ...contact };
}

/** Stable report ordering, so a snapshot or a log line does not depend on timing. */
function sortByChannel(skipped: readonly SkippedChannel[]): readonly SkippedChannel[] {
  return [...skipped].sort((a, b) => a.channel.localeCompare(b.channel));
}
