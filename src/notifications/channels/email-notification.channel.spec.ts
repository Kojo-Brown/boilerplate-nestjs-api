import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { EMAIL_QUEUE, EmailJobName } from "@/queue/email/email-queue.constants";
import { EmailQueueService } from "@/queue/email/email-queue.service";
import { EmailNotificationChannel } from "./email-notification.channel";
import type { Notification, NotificationRecipient } from "../ports";

const RECIPIENT: NotificationRecipient = {
  userId: "user-1",
  email: "ivy@example.com",
  phone: "+15551234567",
};

const NOTIFICATION: Notification = {
  category: "transactional",
  title: "Your invoice is ready",
  body: "Invoice #42 is available in your account.",
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: "job-77" }),
};

describe("EmailNotificationChannel", () => {
  let channel: EmailNotificationChannel;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EmailQueueService,
        EmailNotificationChannel,
        { provide: getQueueToken(EMAIL_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    channel = module.get(EmailNotificationChannel);
    jest.clearAllMocks();
  });

  it("is always configured, because the queue is ours rather than a third party's", () => {
    expect(channel.isConfigured).toBe(true);
  });

  describe("addressFor", () => {
    it.each([
      ["ivy@example.com", "ivy@example.com"],
      ["  ivy@example.com  ", "ivy@example.com"],
      ["not-an-email", null],
      ["missing@domain", null],
      ["", null],
    ])("resolves %s to %s", (email, expected) => {
      expect(channel.addressFor({ userId: "u", email })).toBe(expected);
    });

    it("is null for a user row with no email", () => {
      expect(channel.addressFor({ userId: "u", email: null })).toBeNull();
    });
  });

  describe("send", () => {
    it("enqueues the notification rather than sending it inline", async () => {
      const delivery = await channel.send(RECIPIENT, NOTIFICATION);

      expect(mockQueue.add).toHaveBeenCalledWith(
        EmailJobName.SEND_NOTIFICATION,
        {
          to: "ivy@example.com",
          subject: "Your invoice is ready",
          body: "Invoice #42 is available in your account.",
        },
        expect.objectContaining({ attempts: 5 }),
      );
      expect(delivery.address).toBe("ivy@example.com");
    });

    it("reports queued, not sent — the worker has not run yet", async () => {
      // A caller that told a user "we emailed you" off the back of this would
      // be claiming something that has not happened.
      const delivery = await channel.send(RECIPIENT, NOTIFICATION);

      expect(delivery.status).toBe("queued");
    });

    it("reports the job id so the message can be traced through the queue", async () => {
      const delivery = await channel.send(RECIPIENT, NOTIFICATION);

      expect(delivery.providerMessageId).toBe("job-77");
    });

    it("rejects a recipient with no usable address instead of enqueuing", async () => {
      await expect(channel.send({ userId: "u", email: "nonsense" }, NOTIFICATION)).rejects.toThrow(
        /No usable email address/,
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("propagates a queue outage rather than swallowing it", async () => {
      // An unreachable Redis is an outage the dispatcher should record as a
      // failure, not a channel quietly reporting success.
      mockQueue.add.mockRejectedValueOnce(new Error("Redis connection lost"));

      await expect(channel.send(RECIPIENT, NOTIFICATION)).rejects.toThrow("Redis connection lost");
    });
  });
});
