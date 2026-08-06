import { NotificationAddressRejectedError, NotificationChannelError } from "../notification.errors";
import { PushNotificationChannel } from "./push-notification.channel";
import { FakeExpoPushApi } from "@/test-utils/fake-expo-push-api";
import { stubConfig } from "@/test-utils/stub-config";
import type { Notification, NotificationRecipient } from "../ports";

const BASE_URL = "https://expo.test";
const ACCESS_TOKEN = "fake-expo-access-token";

const PHONE_TOKEN = "ExponentPushToken[fake-device-0001]";
const TABLET_TOKEN = "ExponentPushToken[fake-device-0002]";

const RECIPIENT: NotificationRecipient = {
  userId: "user-1",
  email: "henry@example.com",
  deviceTokens: [PHONE_TOKEN],
};

const NOTIFICATION: Notification = {
  category: "transactional",
  title: "Delivery on its way",
  body: "Your order will arrive today.",
};

const realFetch = global.fetch;

let api: FakeExpoPushApi;

const channel = (overrides: Record<string, string | undefined> = {}): PushNotificationChannel =>
  new PushNotificationChannel(
    stubConfig({
      EXPO_ACCESS_TOKEN: ACCESS_TOKEN,
      EXPO_PUSH_API_BASE_URL: BASE_URL,
      ...overrides,
    }),
  );

beforeEach(() => {
  api = new FakeExpoPushApi(BASE_URL, ACCESS_TOKEN);
  global.fetch = api.fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("PushNotificationChannel", () => {
  describe("configuration", () => {
    it("is configured once an access token is present", () => {
      expect(channel().isConfigured).toBe(true);
    });

    it("is not configured without one", () => {
      // Expo's endpoint would accept an unauthenticated request, which is
      // exactly why this channel refuses to consider itself ready without a
      // token: anyone holding a device token could otherwise push to it.
      expect(channel({ EXPO_ACCESS_TOKEN: undefined }).isConfigured).toBe(false);
    });

    it("constructs cleanly with nothing configured and refuses work later", async () => {
      const unconfigured = channel({ EXPO_ACCESS_TOKEN: undefined });

      await expect(unconfigured.send(RECIPIENT, NOTIFICATION)).rejects.toThrow(
        /Push is not configured/,
      );
    });
  });

  describe("addressFor", () => {
    it("counts devices rather than exposing a token", () => {
      // A push token is a credential for reaching someone's phone and has no
      // business in a delivery report or a log line.
      const address = channel().addressFor({
        userId: "u",
        deviceTokens: [PHONE_TOKEN, TABLET_TOKEN],
      });

      expect(address).toBe("2 devices");
      expect(address).not.toContain("fake-device");
    });

    it("uses the singular for one device", () => {
      expect(channel().addressFor(RECIPIENT)).toBe("1 device");
    });

    it("ignores values that are not Expo push tokens", () => {
      expect(channel().addressFor({ userId: "u", deviceTokens: ["not-a-token", ""] })).toBeNull();
    });

    it("accepts the older ExpoPushToken form Expo still issues", () => {
      expect(
        channel().addressFor({ userId: "u", deviceTokens: ["ExpoPushToken[legacy-0001]"] }),
      ).toBe("1 device");
    });

    it("is null for a recipient with no devices", () => {
      expect(channel().addressFor({ userId: "u" })).toBeNull();
    });
  });

  describe("send", () => {
    it("delivers to every registered device in one batch", async () => {
      const delivery = await channel().send(
        { ...RECIPIENT, deviceTokens: [PHONE_TOKEN, TABLET_TOKEN] },
        NOTIFICATION,
      );

      expect(delivery.status).toBe("sent");
      expect(delivery.address).toBe("2 devices");
      expect(api.messages.map((m) => m.to)).toEqual([PHONE_TOKEN, TABLET_TOKEN]);
    });

    it("carries the title, body and structured data", async () => {
      await channel().send(RECIPIENT, { ...NOTIFICATION, data: { orderId: "order-7" } });

      expect(api.messages[0]).toMatchObject({
        title: "Delivery on its way",
        body: "Your order will arrive today.",
      });
    });

    it("asks for high priority on a transactional message and normal on marketing", async () => {
      await channel().send(RECIPIENT, NOTIFICATION);
      await channel().send(RECIPIENT, { ...NOTIFICATION, category: "marketing" });

      expect(api.messages.map((m) => m.priority)).toEqual(["high", "normal"]);
    });

    it("rejects when the access token is wrong", async () => {
      await expect(
        channel({ EXPO_ACCESS_TOKEN: "wrong-token" }).send(RECIPIENT, NOTIFICATION),
      ).rejects.toThrow(NotificationChannelError);
    });

    it("succeeds when one of several devices is dead", async () => {
      // One stale token from a phone someone replaced must not suppress the
      // notification their current phone did receive.
      api.killToken(TABLET_TOKEN);

      const delivery = await channel().send(
        { ...RECIPIENT, deviceTokens: [PHONE_TOKEN, TABLET_TOKEN] },
        NOTIFICATION,
      );

      expect(delivery.status).toBe("sent");
      expect(delivery.address).toBe("1 device");
    });

    it("reports an address rejection when every device is unregistered", async () => {
      api.killToken(PHONE_TOKEN);

      await expect(channel().send(RECIPIENT, NOTIFICATION)).rejects.toThrow(
        NotificationAddressRejectedError,
      );
    });

    it("reports a non-address batch failure as a channel error", async () => {
      api.killToken(PHONE_TOKEN, "MessageTooBig");

      const error = await channel()
        .send(RECIPIENT, NOTIFICATION)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotificationChannelError);
      expect(error).not.toBeInstanceOf(NotificationAddressRejectedError);
    });

    it("rejects a recipient with no devices instead of calling Expo", async () => {
      await expect(channel().send({ userId: "u" }, NOTIFICATION)).rejects.toThrow(
        /No registered device tokens/,
      );
      expect(api.messages).toEqual([]);
    });
  });
});
