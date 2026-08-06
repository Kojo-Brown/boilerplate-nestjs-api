/**
 * Every channel the dispatcher can select.
 *
 * Declared here rather than in `config/env.schema.ts` or in the preferences
 * type so the domain owns its own vocabulary and the other layers import it —
 * adding a channel is a change in `src/notifications` that the env schema and
 * the preference mapping pick up as a type error rather than silently ignore.
 */
export const NOTIFICATION_CHANNEL_NAMES = ["email", "sms", "push"] as const;

export type NotificationChannelName = (typeof NOTIFICATION_CHANNEL_NAMES)[number];

/**
 * Why a notification is being sent, which decides whether a user may opt out.
 *
 * `transactional` is the message a user asked for by doing something — a
 * password reset, a receipt, a security alert. `marketing` is everything the
 * product wants to say unprompted. The distinction is not decoration: it is the
 * one input other than preferences that changes which channels the dispatcher
 * selects, and shipping it now is cheaper than retrofitting an opt-out
 * exemption once callers exist.
 */
export type NotificationCategory = "transactional" | "marketing";

/**
 * The addresses a user can be reached at.
 *
 * Assembled by the caller rather than loaded from the database, because the
 * `User` model stores an email address and nothing else: there is no `phone`
 * column and no device-token table yet. Passing the addresses in keeps this
 * module honest about that — an SMS channel that silently read a column which
 * does not exist would be worse than one that reports `no-address`. See
 * `recipientFromUser`, which builds the email half from a row and takes the
 * rest from whatever the caller has.
 */
export interface NotificationRecipient {
  readonly userId: string;
  readonly email?: string | null;
  /** E.164, e.g. `+15551234567`. Anything else is rejected by the SMS channel. */
  readonly phone?: string | null;
  /** Zero or more registered devices. A user with three devices gets three sends. */
  readonly deviceTokens?: readonly string[];
}

/**
 * What to say, in a form every channel can render.
 *
 * `title` is a real subject line for email and a real notification title for
 * push; SMS has neither, so its channel folds the title into the message body.
 * That asymmetry lives inside each channel rather than in the caller, which is
 * what lets one `notify()` call fan out to three transports.
 */
export interface Notification {
  readonly category: NotificationCategory;
  readonly title: string;
  readonly body: string;
  /**
   * Structured payload for channels that can carry one (push). Ignored by SMS
   * and email. Values are strings because that is the intersection of what the
   * transports guarantee to deliver unmangled.
   */
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * Where a single send ended up.
 *
 * `sent` means the transport accepted it and the message is on its way;
 * `queued` means it was handed to our own durable queue and will be attempted
 * later. Distinguishing them matters: a caller that reports "notification sent"
 * to a user off the back of a `queued` result is lying, because the worker has
 * not run yet.
 */
export interface NotificationDelivery {
  readonly channel: NotificationChannelName;
  readonly status: "sent" | "queued";
  /** The address actually used — a redacted phone number, an email, a token. */
  readonly address: string;
  /** Upstream identifier, kept for log correlation. A Twilio SID, a BullMQ job id. */
  readonly providerMessageId?: string;
}

/**
 * A delivery transport, as the dispatcher sees one — the Strategy of the
 * pattern.
 *
 * Every channel is interchangeable behind these four members, which is what
 * lets `NotificationDispatcher` hold a collection of them and pick per user
 * without naming one. Nothing outside this module ever references
 * `SmsNotificationChannel`: adding a fourth transport (Slack, webhook, in-app inbox)
 * is one class plus one line in `notifications.module.ts`, and neither the
 * dispatcher nor any caller changes (OCP).
 */
export interface NotificationChannel {
  readonly channel: NotificationChannelName;

  /**
   * Whether the credentials this channel needs are present.
   *
   * Nest instantiates every channel eagerly, so an unconfigured Twilio must
   * construct cleanly and refuse work later — the same shape `StorageService`
   * and the payment providers use. The dispatcher checks this before selecting
   * one, so a deployment without SMS credentials degrades to email and push
   * instead of throwing on every notification.
   */
  readonly isConfigured: boolean;

  /**
   * The address this channel would deliver to, or `null` if it cannot reach
   * this recipient at all.
   *
   * Separate from `send()` so the dispatcher can report *why* a channel was
   * skipped without attempting a doomed request, and so validation of the
   * address format lives with the channel that understands it — E.164 is the
   * SMS channel's problem, `ExponentPushToken[…]` is push's.
   */
  addressFor(recipient: NotificationRecipient): string | null;

  /**
   * Delivers the notification. Rejects if the transport refuses it.
   *
   * Only ever called with a recipient `addressFor` accepted, so an
   * implementation may assume an address exists. It may not assume the
   * transport is healthy: a rejection here is normal and the dispatcher records
   * it against this channel alone.
   */
  send(recipient: NotificationRecipient, notification: Notification): Promise<NotificationDelivery>;
}

/**
 * DI token for the array of every registered {@link NotificationChannel}.
 *
 * The dispatcher injects the collection rather than the three concrete classes,
 * so it holds no reference to any implementation.
 */
export const NOTIFICATION_CHANNELS = Symbol("NOTIFICATION_CHANNELS");
