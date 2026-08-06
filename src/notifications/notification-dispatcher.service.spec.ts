import { Test } from "@nestjs/testing";
import { USER_PREFERENCES_STORE } from "@/users/ports";
import type { UserPreferencesStore } from "@/users/ports";
import { DEFAULT_USER_PREFERENCES } from "@/users/types/user-preferences";
import type { UserPreferences } from "@/users/types/user-preferences";
import { NotificationDispatcher, recipientFromUser } from "./notification-dispatcher.service";
import { NOTIFICATION_CHANNELS } from "./ports";
import type {
  Notification,
  NotificationChannel,
  NotificationChannelName,
  NotificationDelivery,
  NotificationRecipient,
} from "./ports";

const RECIPIENT: NotificationRecipient = {
  userId: "user-1",
  email: "erin@example.com",
  phone: "+15551234567",
  deviceTokens: ["ExponentPushToken[fake-device-0001]"],
};

const TRANSACTIONAL: Notification = {
  category: "transactional",
  title: "Password changed",
  body: "If this was not you, contact support.",
};

const MARKETING: Notification = {
  category: "marketing",
  title: "New this month",
  body: "Three features we think you will like.",
};

/**
 * A channel whose configuration, reachability and outcome are all set by the
 * test. Deliberately a hand-written double rather than `jest.fn()` scaffolding:
 * the dispatcher's whole job is branching on these three properties, so a test
 * reads better when they are named.
 */
class StubChannel implements NotificationChannel {
  sendCalls = 0;

  constructor(
    readonly channel: NotificationChannelName,
    private readonly options: {
      configured?: boolean;
      address?: string | null;
      fail?: Error;
      status?: "sent" | "queued";
    } = {},
  ) {}

  get isConfigured(): boolean {
    return this.options.configured ?? true;
  }

  addressFor(): string | null {
    return this.options.address === undefined ? `${this.channel}-address` : this.options.address;
  }

  async send(): Promise<NotificationDelivery> {
    this.sendCalls += 1;
    if (this.options.fail) throw this.options.fail;
    return {
      channel: this.channel,
      status: this.options.status ?? "sent",
      address: `${this.channel}-address`,
      providerMessageId: `${this.channel}-1`,
    };
  }
}

const prefs = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  ...DEFAULT_USER_PREFERENCES,
  ...overrides,
});

const ALL_ON = prefs({
  emailNotifications: true,
  smsNotifications: true,
  pushNotifications: true,
});

async function buildDispatcher(
  channels: NotificationChannel[],
  preferences: UserPreferences = ALL_ON,
): Promise<{ dispatcher: NotificationDispatcher; store: UserPreferencesStore }> {
  const store: UserPreferencesStore = {
    getPreferences: jest.fn().mockResolvedValue(preferences),
    setPreferences: jest.fn(),
  };

  const module = await Test.createTestingModule({
    providers: [
      NotificationDispatcher,
      { provide: NOTIFICATION_CHANNELS, useValue: channels },
      { provide: USER_PREFERENCES_STORE, useValue: store },
    ],
  }).compile();

  return { dispatcher: module.get(NotificationDispatcher), store };
}

describe("NotificationDispatcher", () => {
  describe("registration", () => {
    it("rejects two channels claiming the same name at construction", async () => {
      await expect(
        buildDispatcher([new StubChannel("sms"), new StubChannel("sms")]),
      ).rejects.toThrow(/Duplicate notification channel/);
    });

    it("reports registered channels whether or not they are configured", async () => {
      const { dispatcher } = await buildDispatcher([
        new StubChannel("email"),
        new StubChannel("sms", { configured: false }),
      ]);

      expect(dispatcher.registered).toEqual(["email", "sms"]);
      expect(dispatcher.available).toEqual(["email"]);
    });
  });

  describe("selection by preference", () => {
    it("delivers only on the channels the user enabled", async () => {
      const email = new StubChannel("email");
      const sms = new StubChannel("sms");
      const push = new StubChannel("push");
      const { dispatcher } = await buildDispatcher(
        [email, sms, push],
        prefs({ emailNotifications: true, smsNotifications: false, pushNotifications: true }),
      );

      const report = await dispatcher.notify(RECIPIENT, MARKETING);

      expect(report.delivered.map((d) => d.channel)).toEqual(["email", "push"]);
      expect(sms.sendCalls).toBe(0);
      expect(report.skipped).toContainEqual({ channel: "sms", reason: "preference-disabled" });
    });

    it("reads preferences from the store on every call", async () => {
      const { dispatcher, store } = await buildDispatcher([new StubChannel("email")]);

      await dispatcher.notify(RECIPIENT, MARKETING);
      await dispatcher.notify(RECIPIENT, MARKETING);

      // Caching them would mean an unsubscribe took effect only after a restart.
      expect(store.getPreferences).toHaveBeenCalledTimes(2);
      expect(store.getPreferences).toHaveBeenCalledWith(RECIPIENT.userId);
    });

    it("sends nothing for a marketing message the user opted out of entirely", async () => {
      const email = new StubChannel("email");
      const { dispatcher } = await buildDispatcher(
        [email],
        prefs({ emailNotifications: false, smsNotifications: false, pushNotifications: false }),
      );

      const report = await dispatcher.notify(RECIPIENT, MARKETING);

      expect(report.delivered).toEqual([]);
      expect(email.sendCalls).toBe(0);
    });

    it("still delivers a transactional message when every channel is switched off", async () => {
      const email = new StubChannel("email");
      const { dispatcher } = await buildDispatcher(
        [email, new StubChannel("sms"), new StubChannel("push")],
        prefs({ emailNotifications: false, smsNotifications: false, pushNotifications: false }),
      );

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(report.delivered.map((d) => d.channel)).toEqual(["email"]);
      expect(report.skipped.map((s) => s.channel)).toEqual(["push", "sms"]);
    });

    it("uses preferences the caller already loaded without hitting the store", async () => {
      const { dispatcher, store } = await buildDispatcher([new StubChannel("email")]);

      const report = await dispatcher.notifyWith(RECIPIENT, MARKETING, prefs());

      expect(store.getPreferences).not.toHaveBeenCalled();
      expect(report.delivered).toHaveLength(1);
    });
  });

  describe("narrowing an enabled channel", () => {
    it("skips a channel with no credentials rather than attempting it", async () => {
      const sms = new StubChannel("sms", { configured: false });
      const { dispatcher } = await buildDispatcher([new StubChannel("email"), sms]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(sms.sendCalls).toBe(0);
      expect(report.skipped).toContainEqual({ channel: "sms", reason: "not-configured" });
      expect(report.delivered.map((d) => d.channel)).toEqual(["email"]);
    });

    it("skips a channel that cannot reach this recipient", async () => {
      const push = new StubChannel("push", { address: null });
      const { dispatcher } = await buildDispatcher([new StubChannel("email"), push]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(push.sendCalls).toBe(0);
      expect(report.skipped).toContainEqual({ channel: "push", reason: "no-address" });
    });

    it("distinguishes not-configured from no-address", async () => {
      // Both end in "nothing sent", but only one of them is an operator's
      // problem. Collapsing them would make an outage undebuggable from a log.
      const { dispatcher } = await buildDispatcher([
        new StubChannel("email"),
        new StubChannel("sms", { configured: false }),
        new StubChannel("push", { address: null }),
      ]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(report.skipped).toEqual([
        { channel: "push", reason: "no-address" },
        { channel: "sms", reason: "not-configured" },
      ]);
    });
  });

  describe("failure isolation", () => {
    it("delivers on the healthy channels when one transport fails", async () => {
      const sms = new StubChannel("sms", { fail: new Error("Twilio 500") });
      const { dispatcher } = await buildDispatcher([
        new StubChannel("email", { status: "queued" }),
        sms,
        new StubChannel("push"),
      ]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(report.delivered.map((d) => d.channel)).toEqual(["email", "push"]);
      expect(report.skipped).toEqual([{ channel: "sms", reason: "failed", error: "Twilio 500" }]);
    });

    it("does not throw when every channel fails", async () => {
      const { dispatcher } = await buildDispatcher([
        new StubChannel("email", { fail: new Error("Redis down") }),
      ]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      // A caller that treats a notification as best-effort must not have to
      // wrap every call in a try/catch to keep its own transaction alive.
      expect(report.delivered).toEqual([]);
      expect(report.skipped).toEqual([{ channel: "email", reason: "failed", error: "Redis down" }]);
    });

    it("attempts every eligible channel even though an earlier one rejected", async () => {
      const push = new StubChannel("push");
      const { dispatcher } = await buildDispatcher([
        new StubChannel("email", { fail: new Error("boom") }),
        push,
      ]);

      await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      // A rejection must not abandon the sends still in flight beside it.
      expect(push.sendCalls).toBe(1);
    });
  });

  describe("the report", () => {
    it("preserves each channel's own status rather than flattening it", async () => {
      const { dispatcher } = await buildDispatcher([
        new StubChannel("email", { status: "queued" }),
        new StubChannel("sms", { status: "sent" }),
      ]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(report.delivered).toEqual([
        expect.objectContaining({ channel: "email", status: "queued" }),
        expect.objectContaining({ channel: "sms", status: "sent" }),
      ]);
    });

    it("echoes the user it dispatched for", async () => {
      const { dispatcher } = await buildDispatcher([new StubChannel("email")]);

      const report = await dispatcher.notify(RECIPIENT, TRANSACTIONAL);

      expect(report.userId).toBe(RECIPIENT.userId);
    });
  });

  describe("recipientFromUser", () => {
    it("takes the email from the row and the rest from the caller", () => {
      const recipient = recipientFromUser(
        { id: "user-9", email: "frank@example.com" },
        { phone: "+15559876543" },
      );

      expect(recipient).toEqual({
        userId: "user-9",
        email: "frank@example.com",
        phone: "+15559876543",
      });
    });

    it("works with only a row, leaving the other channels unreachable", () => {
      const recipient = recipientFromUser({ id: "user-9", email: "frank@example.com" });

      expect(recipient.phone).toBeUndefined();
      expect(recipient.deviceTokens).toBeUndefined();
    });
  });
});
