export const EMAIL_QUEUE = "email" as const;

export const EmailJobName = {
  SEND_WELCOME: "send-welcome",
  SEND_PASSWORD_RESET: "send-password-reset",
  SEND_VERIFICATION: "send-verification",
  /**
   * The generic job behind `EmailNotificationChannel`. The three above are
   * fixed lifecycle emails with their own templates; this one carries a
   * subject and a body composed by the notifications module.
   */
  SEND_NOTIFICATION: "send-notification",
} as const;

export type EmailJobName = (typeof EmailJobName)[keyof typeof EmailJobName];
