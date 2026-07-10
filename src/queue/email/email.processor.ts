import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { EMAIL_QUEUE, EmailJobName } from "./email-queue.constants";
import type {
  WelcomeEmailData,
  PasswordResetEmailData,
  VerificationEmailData,
} from "./dto/email-job.types";

@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.debug(`Processing job ${job.id} name=${job.name}`);

    switch (job.name as EmailJobName) {
      case EmailJobName.SEND_WELCOME:
        await this.handleWelcomeEmail(job.data as WelcomeEmailData);
        break;
      case EmailJobName.SEND_PASSWORD_RESET:
        await this.handlePasswordResetEmail(job.data as PasswordResetEmailData);
        break;
      case EmailJobName.SEND_VERIFICATION:
        await this.handleVerificationEmail(job.data as VerificationEmailData);
        break;
      default:
        this.logger.warn(`Unrecognised job name: ${job.name}`);
    }
  }

  private async handleWelcomeEmail(data: WelcomeEmailData): Promise<void> {
    this.logger.log(`Sending welcome email to ${data.to} (name=${data.name})`);
    // Replace with a real mail provider (e.g. nodemailer, Resend, SendGrid).
    await Promise.resolve();
  }

  private async handlePasswordResetEmail(data: PasswordResetEmailData): Promise<void> {
    this.logger.log(`Sending password-reset email to ${data.to}`);
    // Replace with a real mail provider.
    await Promise.resolve();
  }

  private async handleVerificationEmail(data: VerificationEmailData): Promise<void> {
    this.logger.log(`Sending verification email to ${data.to}`);
    // Replace with a real mail provider.
    await Promise.resolve();
  }
}
