import { Injectable } from "@nestjs/common";
import { EmailQueueService } from "@/queue/email/email-queue.service";
import { NotificationChannelError } from "../notification.errors";
import type {
  Notification,
  NotificationChannel,
  NotificationChannelName,
  NotificationDelivery,
  NotificationRecipient,
} from "../ports";

/**
 * Deliberately permissive: this is a guard against an obviously unusable value
 * reaching the queue, not an attempt to validate an address the registration
 * flow already accepted. RFC 5322 in a regex is a well-known mistake.
 */
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email delivery through the existing BullMQ email queue.
 *
 * The odd one of the three: SMS and push hand their message to a third party
 * synchronously, while this one hands it to our own durable queue and returns.
 * That is why {@link NotificationDelivery} has a `queued` status as well as
 * `sent` — collapsing the two would have this channel claim an email was
 * delivered when all that happened is a Redis write.
 *
 * Going through the queue rather than calling a mail API directly is the point:
 * retries, backoff and the eventual mail provider already live in
 * `EmailProcessor`, and duplicating them here would mean a notification email
 * and a password-reset email retried under different rules.
 */
@Injectable()
export class EmailNotificationChannel implements NotificationChannel {
  readonly channel: NotificationChannelName = "email";

  constructor(private readonly emailQueue: EmailQueueService) {}

  /**
   * Always true. The queue is part of the application rather than a third-party
   * account, so there are no credentials that can be missing — and if Redis is
   * down, `send()` rejects and the dispatcher records a failure, which is the
   * right shape for an outage as opposed to a misconfiguration.
   */
  readonly isConfigured = true;

  addressFor(recipient: NotificationRecipient): string | null {
    const email = recipient.email?.trim();
    return email && EMAIL_SHAPED.test(email) ? email : null;
  }

  async send(
    recipient: NotificationRecipient,
    notification: Notification,
  ): Promise<NotificationDelivery> {
    const to = this.addressFor(recipient);
    if (!to) {
      throw new NotificationChannelError(
        this.channel,
        `No usable email address for user ${recipient.userId}`,
      );
    }

    const jobId = await this.emailQueue.sendNotificationEmail({
      to,
      subject: notification.title,
      body: notification.body,
    });

    return {
      channel: this.channel,
      status: "queued",
      address: to,
      providerMessageId: jobId,
    };
  }
}
