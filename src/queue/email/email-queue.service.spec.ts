import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { EmailQueueService } from "./email-queue.service";
import { EMAIL_QUEUE, EmailJobName } from "./email-queue.constants";
import type { WelcomeEmailData, PasswordResetEmailData, VerificationEmailData } from "./dto/email-job.types";

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: "job-1" }),
  getWaitingCount: jest.fn().mockResolvedValue(2),
  getActiveCount: jest.fn().mockResolvedValue(1),
  getCompletedCount: jest.fn().mockResolvedValue(10),
  getFailedCount: jest.fn().mockResolvedValue(0),
  getDelayedCount: jest.fn().mockResolvedValue(0),
};

describe("EmailQueueService", () => {
  let service: EmailQueueService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailQueueService,
        { provide: getQueueToken(EMAIL_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(EmailQueueService);
    jest.clearAllMocks();
  });

  describe("sendWelcomeEmail", () => {
    it("enqueues a send-welcome job with the correct data", async () => {
      const data: WelcomeEmailData = { to: "alice@example.com", name: "Alice" };
      await service.sendWelcomeEmail(data);

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        EmailJobName.SEND_WELCOME,
        data,
        expect.objectContaining({ attempts: 3 }),
      );
    });
  });

  describe("sendPasswordResetEmail", () => {
    it("enqueues a send-password-reset job with the correct data", async () => {
      const data: PasswordResetEmailData = {
        to: "bob@example.com",
        resetToken: "tok123",
        resetUrl: "https://app.example.com/reset?token=tok123",
      };
      await service.sendPasswordResetEmail(data);

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        EmailJobName.SEND_PASSWORD_RESET,
        data,
        expect.objectContaining({ attempts: 3 }),
      );
    });
  });

  describe("sendVerificationEmail", () => {
    it("enqueues a send-verification job with the correct data", async () => {
      const data: VerificationEmailData = {
        to: "carol@example.com",
        verificationToken: "vtok456",
        verificationUrl: "https://app.example.com/verify?token=vtok456",
      };
      await service.sendVerificationEmail(data);

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        EmailJobName.SEND_VERIFICATION,
        data,
        expect.objectContaining({ attempts: 3 }),
      );
    });
  });

  describe("getQueueStats", () => {
    it("returns aggregated queue counts", async () => {
      const stats = await service.getQueueStats();

      expect(stats).toEqual({
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 0,
        delayed: 0,
      });
    });
  });
});
