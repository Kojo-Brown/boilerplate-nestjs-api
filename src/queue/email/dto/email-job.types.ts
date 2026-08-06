export interface WelcomeEmailData {
  to: string;
  name: string;
}

export interface PasswordResetEmailData {
  to: string;
  resetToken: string;
  resetUrl: string;
}

export interface VerificationEmailData {
  to: string;
  verificationToken: string;
  verificationUrl: string;
}

/**
 * A notification rendered for email by `EmailNotificationChannel`.
 *
 * Deliberately template-free: the notifications module owns the copy, and the
 * queue owns durability and retries. Adding a template id here would put the
 * same decision in two places.
 */
export interface NotificationEmailData {
  to: string;
  subject: string;
  body: string;
}

export type EmailJobData =
  WelcomeEmailData | PasswordResetEmailData | VerificationEmailData | NotificationEmailData;
