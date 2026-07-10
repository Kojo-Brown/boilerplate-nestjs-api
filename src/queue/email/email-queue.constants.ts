export const EMAIL_QUEUE = 'email' as const;

export const EmailJobName = {
  SEND_WELCOME: 'send-welcome',
  SEND_PASSWORD_RESET: 'send-password-reset',
  SEND_VERIFICATION: 'send-verification',
} as const;

export type EmailJobName = (typeof EmailJobName)[keyof typeof EmailJobName];
