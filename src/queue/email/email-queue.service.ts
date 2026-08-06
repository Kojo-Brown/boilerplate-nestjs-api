import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { EMAIL_QUEUE, EmailJobName } from "./email-queue.constants";
import type {
  WelcomeEmailData,
  PasswordResetEmailData,
  VerificationEmailData,
  NotificationEmailData,
} from "./dto/email-job.types";

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 } as const,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
} as const;

@Injectable()
export class EmailQueueService {
  private readonly logger = new Logger(EmailQueueService.name);

  constructor(@InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue) {}

  async sendWelcomeEmail(data: WelcomeEmailData): Promise<void> {
    await this.emailQueue.add(EmailJobName.SEND_WELCOME, data, DEFAULT_JOB_OPTIONS);
    this.logger.debug(`Enqueued ${EmailJobName.SEND_WELCOME} for ${data.to}`);
  }

  async sendPasswordResetEmail(data: PasswordResetEmailData): Promise<void> {
    await this.emailQueue.add(EmailJobName.SEND_PASSWORD_RESET, data, DEFAULT_JOB_OPTIONS);
    this.logger.debug(`Enqueued ${EmailJobName.SEND_PASSWORD_RESET} for ${data.to}`);
  }

  async sendVerificationEmail(data: VerificationEmailData): Promise<void> {
    await this.emailQueue.add(EmailJobName.SEND_VERIFICATION, data, DEFAULT_JOB_OPTIONS);
    this.logger.debug(`Enqueued ${EmailJobName.SEND_VERIFICATION} for ${data.to}`);
  }

  /**
   * Enqueues an arbitrary notification email and resolves with the job id.
   *
   * The id is returned, unlike the three above, because `EmailNotificationChannel`
   * reports it as the delivery's `providerMessageId` — it is the only handle
   * anyone has on a message that has been accepted but not yet sent. BullMQ
   * always assigns one, but types it optional, so the fallback keeps the
   * channel's return type honest rather than asserting non-null.
   */
  async sendNotificationEmail(data: NotificationEmailData): Promise<string> {
    const job = await this.emailQueue.add(EmailJobName.SEND_NOTIFICATION, data, {
      ...DEFAULT_JOB_OPTIONS,
      // A notification is worth more attempts than a lifecycle email: it is
      // often the only copy of information the user will get, and the fallback
      // rule in `selectChannels` may have made this the sole channel.
      attempts: 5,
    });
    this.logger.debug(`Enqueued ${EmailJobName.SEND_NOTIFICATION} for ${data.to}`);
    return job.id ?? "unknown";
  }

  async getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.emailQueue.getWaitingCount(),
      this.emailQueue.getActiveCount(),
      this.emailQueue.getCompletedCount(),
      this.emailQueue.getFailedCount(),
      this.emailQueue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }
}
