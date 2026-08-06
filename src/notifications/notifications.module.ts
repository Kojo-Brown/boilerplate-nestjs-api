import { Module } from "@nestjs/common";
import { UsersModule } from "@/users/users.module";
import { QueueModule } from "@/queue/queue.module";
import { EmailNotificationChannel } from "./channels/email-notification.channel";
import { PushNotificationChannel } from "./channels/push-notification.channel";
import { SmsNotificationChannel } from "./channels/sms-notification.channel";
import { NotificationDispatcher } from "./notification-dispatcher.service";
import { NOTIFICATION_CHANNELS } from "./ports";
import type { NotificationChannel } from "./ports";

/**
 * The only file that knows which delivery channels exist.
 *
 * Registering a fourth — Slack, a webhook, an in-app inbox — is the class in
 * `providers`, the class in `inject`, and one entry in the preference map;
 * `NotificationDispatcher` and every caller are untouched.
 *
 * Imports `UsersModule` for the preferences port and `QueueModule` for the
 * email queue. The dependency runs notifications → users and never back, so
 * `UsersService` can gain a notification without a circular import.
 */
@Module({
  imports: [UsersModule, QueueModule],
  providers: [
    EmailNotificationChannel,
    SmsNotificationChannel,
    PushNotificationChannel,
    {
      provide: NOTIFICATION_CHANNELS,
      inject: [EmailNotificationChannel, SmsNotificationChannel, PushNotificationChannel],
      useFactory: (...channels: NotificationChannel[]): readonly NotificationChannel[] => channels,
    },
    NotificationDispatcher,
  ],
  // Only the dispatcher leaves the module. Exporting the channels would let a
  // consumer send an SMS directly and bypass the user's preferences entirely,
  // which is the one thing this module exists to prevent.
  exports: [NotificationDispatcher],
})
export class NotificationsModule {}
