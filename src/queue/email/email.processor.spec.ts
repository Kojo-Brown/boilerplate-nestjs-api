import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { EmailProcessor } from "./email.processor";
import { EMAIL_QUEUE, EmailJobName } from "./email-queue.constants";
import type { WelcomeEmailData, PasswordResetEmailData, VerificationEmailData } from "./dto/email-job.types";

const mockQueue = {};

function makeJob<T>(name: string, data: T): Job<T> {
  return { id: "1", name, data } as Job<T>;
}

describe("EmailProcessor", () => {
  let processor: EmailProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailProcessor,
        { provide: getQueueToken(EMAIL_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    processor = module.get(EmailProcessor);
  });

  it("processes send-welcome jobs without throwing", async () => {
    const job = makeJob<WelcomeEmailData>(EmailJobName.SEND_WELCOME, {
      to: "alice@example.com",
      name: "Alice",
    });
    await expect(processor.process(job as Job)).resolves.toBeUndefined();
  });

  it("processes send-password-reset jobs without throwing", async () => {
    const job = makeJob<PasswordResetEmailData>(EmailJobName.SEND_PASSWORD_RESET, {
      to: "bob@example.com",
      resetToken: "tok123",
      resetUrl: "https://app.example.com/reset",
    });
    await expect(processor.process(job as Job)).resolves.toBeUndefined();
  });

  it("processes send-verification jobs without throwing", async () => {
    const job = makeJob<VerificationEmailData>(EmailJobName.SEND_VERIFICATION, {
      to: "carol@example.com",
      verificationToken: "vtok456",
      verificationUrl: "https://app.example.com/verify",
    });
    await expect(processor.process(job as Job)).resolves.toBeUndefined();
  });

  it("handles unknown job names gracefully without throwing", async () => {
    const job = makeJob("unknown-job", {});
    await expect(processor.process(job as Job)).resolves.toBeUndefined();
  });
});
