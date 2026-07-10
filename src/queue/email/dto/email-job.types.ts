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

export type EmailJobData = WelcomeEmailData | PasswordResetEmailData | VerificationEmailData;
