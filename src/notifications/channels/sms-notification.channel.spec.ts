import { NotificationAddressRejectedError, NotificationChannelError } from "../notification.errors";
import { SmsNotificationChannel, composeSms, redactPhone } from "./sms-notification.channel";
import { FakeTwilioApi } from "@/test-utils/fake-twilio-api";
import { stubConfig } from "@/test-utils/stub-config";
import type { Notification, NotificationRecipient } from "../ports";

const BASE_URL = "https://twilio.test";
const ACCOUNT_SID = "ACfake00000000000000000000000000";
const AUTH_TOKEN = "fake-twilio-auth-token";
const FROM_NUMBER = "+15550000000";
const MESSAGING_SERVICE_SID = "MGfake00000000000000000000000000";

const PHONE = "+15551234567";

const RECIPIENT: NotificationRecipient = {
  userId: "user-1",
  email: "grace@example.com",
  phone: PHONE,
};

const NOTIFICATION: Notification = {
  category: "transactional",
  title: "Sign-in code",
  body: "Your code is 123456.",
};

const realFetch = global.fetch;

let api: FakeTwilioApi;

const channel = (overrides: Record<string, string | undefined> = {}): SmsNotificationChannel =>
  new SmsNotificationChannel(
    stubConfig({
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_FROM_NUMBER: FROM_NUMBER,
      TWILIO_API_BASE_URL: BASE_URL,
      ...overrides,
    }),
  );

beforeEach(() => {
  api = new FakeTwilioApi(BASE_URL, ACCOUNT_SID, AUTH_TOKEN);
  global.fetch = api.fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("SmsNotificationChannel", () => {
  describe("configuration", () => {
    it("is configured with an account, a token and a sending number", () => {
      expect(channel().isConfigured).toBe(true);
    });

    it("is configured with a messaging service instead of a number", () => {
      expect(
        channel({
          TWILIO_FROM_NUMBER: undefined,
          TWILIO_MESSAGING_SERVICE_SID: MESSAGING_SERVICE_SID,
        }).isConfigured,
      ).toBe(true);
    });

    it.each(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"])(
      "is not configured without %s",
      (missing) => {
        expect(channel({ [missing]: undefined }).isConfigured).toBe(false);
      },
    );

    it("constructs cleanly with nothing configured and refuses work later", async () => {
      // Nest instantiates every channel eagerly, so an unconfigured Twilio must
      // not throw from the constructor.
      const unconfigured = new SmsNotificationChannel(stubConfig({}));

      expect(unconfigured.isConfigured).toBe(false);
      await expect(unconfigured.send(RECIPIENT, NOTIFICATION)).rejects.toThrow(
        /SMS is not configured/,
      );
    });
  });

  describe("addressFor", () => {
    it.each([
      ["+15551234567", "+15551234567"],
      // Trimmed, so a stray space pasted into a profile form is not a silent
      // "this user has no phone number".
      ["  +15551234567  ", "+15551234567"],
      ["+447700900123", "+447700900123"],
      ["5551234567", null],
      ["+0551234567", null],
      ["+1-555-123-4567", null],
      ["", null],
    ])("resolves %s to %s", (phone, expected) => {
      expect(channel().addressFor({ userId: "u", phone })).toBe(expected);
    });

    it("is null when the recipient has no phone at all", () => {
      expect(channel().addressFor({ userId: "u" })).toBeNull();
    });
  });

  describe("send", () => {
    it("posts a form-encoded message and reports the SID", async () => {
      const delivery = await channel().send(RECIPIENT, NOTIFICATION);

      expect(delivery.status).toBe("sent");
      expect(delivery.providerMessageId).toMatch(/^SM/);
      expect(api.messages).toEqual([
        { to: "+15551234567", from: FROM_NUMBER, body: "Sign-in code: Your code is 123456." },
      ]);
    });

    it("sends a messaging service SID as MessagingServiceSid, not From", async () => {
      // Twilio rejects an `MG…` value in `From`; getting this backwards is a
      // 400 on every message in production and silent everywhere else.
      await channel({
        TWILIO_FROM_NUMBER: undefined,
        TWILIO_MESSAGING_SERVICE_SID: MESSAGING_SERVICE_SID,
      }).send(RECIPIENT, NOTIFICATION);

      expect(api.messages[0]?.from).toBe(MESSAGING_SERVICE_SID);
    });

    it("redacts the phone number in the delivery report", async () => {
      const delivery = await channel().send(RECIPIENT, NOTIFICATION);

      expect(delivery.address).toBe("+155•••4567");
      expect(delivery.address).not.toContain("1234");
    });

    it("rejects with an authentication error when the token is wrong", async () => {
      await expect(
        channel({ TWILIO_AUTH_TOKEN: "wrong-token" }).send(RECIPIENT, NOTIFICATION),
      ).rejects.toThrow(NotificationChannelError);
    });

    it("reports a permanently bad number as an address rejection", async () => {
      api.rejectNumber(PHONE, 21610, "The message cannot be sent: STOP received");

      await expect(channel().send(RECIPIENT, NOTIFICATION)).rejects.toThrow(
        NotificationAddressRejectedError,
      );
    });

    it("reports a transient Twilio failure as a channel error, not an address one", async () => {
      // The distinction is what tells a caller whether to retry or to stop
      // storing the number.
      api.rejectNumber(PHONE, 20429, "Too many requests");

      await expect(channel().send(RECIPIENT, NOTIFICATION)).rejects.toThrow(
        NotificationChannelError,
      );
      await expect(channel().send(RECIPIENT, NOTIFICATION)).rejects.not.toBeInstanceOf(
        NotificationAddressRejectedError,
      );
    });

    it("treats a 201 whose body already says failed as a failure", async () => {
      // Twilio validates some things after creating the resource, so a 2xx is
      // not on its own proof that anything was sent.
      api.failAfterAccept(PHONE, "failed", 30008);

      await expect(channel().send(RECIPIENT, NOTIFICATION)).rejects.toThrow(
        NotificationChannelError,
      );
      expect(api.messages).toEqual([]);
    });

    it("rejects a recipient with no usable number instead of calling Twilio", async () => {
      await expect(
        channel().send({ userId: "u", phone: "nonsense" }, NOTIFICATION),
      ).rejects.toThrow(/No E.164 phone number/);
      expect(api.messages).toEqual([]);
    });
  });

  describe("composeSms", () => {
    it("folds the title into the body, since SMS has no subject", () => {
      expect(composeSms(NOTIFICATION)).toBe("Sign-in code: Your code is 123456.");
    });

    it("truncates rather than fanning out into unbounded billed segments", () => {
      const composed = composeSms({ ...NOTIFICATION, body: "x".repeat(1_000) });

      expect(composed).toHaveLength(320);
      expect(composed.endsWith("…")).toBe(true);
    });

    it("leaves a message that already fits untouched", () => {
      const composed = composeSms({ ...NOTIFICATION, body: "y".repeat(100) });

      expect(composed.endsWith("…")).toBe(false);
    });
  });

  describe("redactPhone", () => {
    it("keeps enough to identify a number and not enough to dial it", () => {
      expect(redactPhone("+15551234567")).toBe("+155•••4567");
    });

    it("leaves a value too short to redact meaningfully alone", () => {
      expect(redactPhone("+1555")).toBe("+1555");
    });
  });
});
