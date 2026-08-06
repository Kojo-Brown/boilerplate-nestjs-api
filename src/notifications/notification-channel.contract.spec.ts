import { describeNotificationChannelContract } from "./notification-channel.contract";
import { EmailNotificationChannel } from "./channels/email-notification.channel";
import { PushNotificationChannel } from "./channels/push-notification.channel";
import { SmsNotificationChannel } from "./channels/sms-notification.channel";
import { FakeExpoPushApi } from "@/test-utils/fake-expo-push-api";
import { FakeTwilioApi } from "@/test-utils/fake-twilio-api";
import { stubConfig } from "@/test-utils/stub-config";
import type { EmailQueueService } from "@/queue/email/email-queue.service";

const TWILIO_BASE_URL = "https://twilio.test";
const TWILIO_ACCOUNT_SID = "ACfake00000000000000000000000000";
const TWILIO_AUTH_TOKEN = "fake-twilio-auth-token";
const TWILIO_FROM_NUMBER = "+15550000000";

const EXPO_BASE_URL = "https://expo.test";
const EXPO_ACCESS_TOKEN = "fake-expo-access-token";

const EMAIL = "dana@example.com";
const PHONE = "+15551234567";
const DEVICE_TOKEN = "ExponentPushToken[fake-device-0001]";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

/**
 * A recipient reachable on every channel, so each harness can describe itself
 * as "this one minus my own address" without repeating the other two.
 */
const fullyReachable = {
  userId: "user-contract",
  email: EMAIL,
  phone: PHONE,
  deviceTokens: [DEVICE_TOKEN],
};

describeNotificationChannelContract("EmailNotificationChannel", () => {
  let jobId = 0;
  const queue = {
    sendNotificationEmail: () => Promise.resolve(`job-${(jobId += 1)}`),
  } as unknown as EmailQueueService;

  return {
    channel: new EmailNotificationChannel(queue),
    reachable: () => fullyReachable,
    unreachable: () => ({ ...fullyReachable, email: null }),
  };
});

describeNotificationChannelContract("SmsNotificationChannel", () => {
  const api = new FakeTwilioApi(TWILIO_BASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  global.fetch = api.fetch;

  return {
    channel: new SmsNotificationChannel(
      stubConfig({
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN,
        TWILIO_FROM_NUMBER,
        TWILIO_API_BASE_URL: TWILIO_BASE_URL,
      }),
    ),
    reachable: () => fullyReachable,
    unreachable: () => ({ ...fullyReachable, phone: null }),
  };
});

describeNotificationChannelContract("PushNotificationChannel", () => {
  const api = new FakeExpoPushApi(EXPO_BASE_URL, EXPO_ACCESS_TOKEN);
  global.fetch = api.fetch;

  return {
    channel: new PushNotificationChannel(
      stubConfig({
        EXPO_ACCESS_TOKEN,
        EXPO_PUSH_API_BASE_URL: EXPO_BASE_URL,
      }),
    ),
    reachable: () => fullyReachable,
    unreachable: () => ({ ...fullyReachable, deviceTokens: [] }),
  };
});
