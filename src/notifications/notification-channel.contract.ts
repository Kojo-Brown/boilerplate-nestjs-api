import { NOTIFICATION_CHANNEL_NAMES } from "./ports";
import type { Notification, NotificationChannel, NotificationRecipient } from "./ports";

/**
 * The behavioural contract every notification channel must satisfy.
 *
 * `NotificationDispatcher` picks a channel at runtime from the user's
 * preferences, so everything downstream must behave identically whichever ones
 * it gets (LSP). The type system only checks four members; what actually breaks
 * a notification is behaviour — a channel that returns an address `addressFor`
 * said it could not reach, one that resolves with `status: "sent"` when it only
 * queued something, or one that throws for a recipient it should have reported
 * as unreachable.
 *
 * So the contract lives here once and `notification-channel.contract.spec.ts`
 * runs it against all three implementations, the two HTTP ones driven by
 * in-process fakes of the real APIs. Adding a channel means adding one line
 * there.
 *
 * `reachable` and `unreachable` are the harness's job because "an address this
 * channel can use" is exactly the part that differs: an email string, an E.164
 * number, an `ExponentPushToken[…]`.
 */
export interface NotificationChannelHarness {
  readonly channel: NotificationChannel;
  /** A recipient this channel can deliver to. */
  reachable(): NotificationRecipient;
  /** A recipient carrying every *other* channel's address but not this one's. */
  unreachable(): NotificationRecipient;
}

const NOTIFICATION: Notification = {
  category: "transactional",
  title: "Your export is ready",
  body: "The report you requested has finished generating.",
};

export function describeNotificationChannelContract(
  name: string,
  createHarness: () => NotificationChannelHarness,
): void {
  describe(`${name} (notification channel contract)`, () => {
    let harness: NotificationChannelHarness;
    let channel: NotificationChannel;

    beforeEach(() => {
      harness = createHarness();
      channel = harness.channel;
    });

    describe("identity", () => {
      it("declares one of the registered channel names", () => {
        expect(NOTIFICATION_CHANNEL_NAMES).toContain(channel.channel);
      });

      it("reports whether it is configured without throwing", () => {
        expect(typeof channel.isConfigured).toBe("boolean");
      });
    });

    describe("addressFor()", () => {
      it("returns an address for a recipient it can reach", () => {
        expect(channel.addressFor(harness.reachable())).toEqual(expect.any(String));
      });

      it("returns null — never undefined — for a recipient it cannot reach", () => {
        // The dispatcher branches on `=== null`, so `undefined` would silently
        // count as reachable and produce a doomed send.
        expect(channel.addressFor(harness.unreachable())).toBeNull();
      });

      it("is stable across calls", () => {
        const recipient = harness.reachable();

        expect(channel.addressFor(recipient)).toBe(channel.addressFor(recipient));
      });

      it("does not treat an empty or whitespace-only address as reachable", () => {
        const blank: NotificationRecipient = {
          userId: "user-blank",
          email: "   ",
          phone: "   ",
          deviceTokens: ["   "],
        };

        expect(channel.addressFor(blank)).toBeNull();
      });
    });

    describe("send()", () => {
      it("reports the channel it delivered on", async () => {
        const delivery = await channel.send(harness.reachable(), NOTIFICATION);

        expect(delivery.channel).toBe(channel.channel);
      });

      it("reports a status the caller can distinguish", async () => {
        const delivery = await channel.send(harness.reachable(), NOTIFICATION);

        // Not just "truthy": a channel that queued must not claim it sent.
        expect(["sent", "queued"]).toContain(delivery.status);
      });

      it("returns a non-empty address describing where it went", async () => {
        const delivery = await channel.send(harness.reachable(), NOTIFICATION);

        expect(delivery.address.length).toBeGreaterThan(0);
      });

      it("carries an upstream identifier for correlation", async () => {
        const delivery = await channel.send(harness.reachable(), NOTIFICATION);

        expect(delivery.providerMessageId).toEqual(expect.any(String));
      });

      it("rejects rather than silently succeeding for an unreachable recipient", async () => {
        // The dispatcher never calls `send` without checking `addressFor`, so
        // this is a defence-in-depth guarantee: a channel must not invent an
        // address or resolve with a delivery that never happened.
        await expect(channel.send(harness.unreachable(), NOTIFICATION)).rejects.toThrow();
      });

      it("delivers a marketing notification the same way as a transactional one", async () => {
        // Category changes *selection*, which is the dispatcher's job. A
        // channel handed a notification must deliver it either way.
        const delivery = await channel.send(harness.reachable(), {
          ...NOTIFICATION,
          category: "marketing",
        });

        expect(["sent", "queued"]).toContain(delivery.status);
      });

      it("accepts a body long enough to need truncating or splitting", async () => {
        const delivery = await channel.send(harness.reachable(), {
          ...NOTIFICATION,
          body: "x".repeat(1_000),
        });

        expect(["sent", "queued"]).toContain(delivery.status);
      });
    });
  });
}
