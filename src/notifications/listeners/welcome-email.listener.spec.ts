import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { EmailQueueService } from "@/queue/email/email-queue.service";
import { WelcomeEmailListener } from "./welcome-email.listener";
import type { DomainEvent } from "@/events";

const event = (
  payload: Partial<DomainEvent<"user.registered">["payload"]> = {},
): DomainEvent<"user.registered"> => ({
  id: "event-1",
  name: "user.registered",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: null,
  payload: {
    userId: "user-1",
    email: "erin@example.com",
    name: "Erin Example",
    provider: null,
    ...payload,
  },
});

/**
 * The listener is called directly here. That it is *subscribed* is the
 * decorator's and the bus's job, and both are covered in `src/events`.
 */
describe("WelcomeEmailListener", () => {
  const emails = { sendWelcomeEmail: jest.fn() };
  let listener: WelcomeEmailListener;

  beforeEach(async () => {
    jest.resetAllMocks();
    emails.sendWelcomeEmail.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [WelcomeEmailListener, { provide: EmailQueueService, useValue: emails }],
    }).compile();

    listener = module.get(WelcomeEmailListener);
  });

  it("queues a welcome email for the address on the event", async () => {
    await listener.onUserRegistered(event());

    expect(emails.sendWelcomeEmail).toHaveBeenCalledWith({
      to: "erin@example.com",
      name: "Erin Example",
    });
  });

  it("greets an OAuth sign-up that carried no name by their address", async () => {
    await listener.onUserRegistered(event({ name: null, provider: "google" }));

    expect(emails.sendWelcomeEmail).toHaveBeenCalledWith({
      to: "erin@example.com",
      name: "erin",
    });
  });

  it("does not treat a blank name as a name", async () => {
    await listener.onUserRegistered(event({ name: "   " }));

    expect(emails.sendWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ name: "erin" }));
  });

  it("falls back to the whole address when there is no local part", async () => {
    await listener.onUserRegistered(event({ name: null, email: "@example.com" }));

    expect(emails.sendWelcomeEmail).toHaveBeenCalledWith({
      to: "@example.com",
      name: "@example.com",
    });
  });

  it("reports a queue failure as a failed outcome rather than throwing", async () => {
    emails.sendWelcomeEmail.mockRejectedValue(new Error("redis down"));
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    // `@OnDomainEvent` has replaced the method: the rejection is contained and
    // described, which is what keeps a registration from failing over an email.
    await expect(listener.onUserRegistered(event())).resolves.toEqual({
      handler: "WelcomeEmailListener.onUserRegistered",
      status: "failed",
      error: "redis down",
    });
  });
});
