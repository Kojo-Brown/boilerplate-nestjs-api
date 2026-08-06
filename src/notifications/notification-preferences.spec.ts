import { DEFAULT_USER_PREFERENCES } from "@/users/types/user-preferences";
import type { UserPreferences } from "@/users/types/user-preferences";
import {
  TRANSACTIONAL_FALLBACK_CHANNEL,
  isChannelEnabled,
  selectChannels,
} from "./notification-preferences";
import { NOTIFICATION_CHANNEL_NAMES } from "./ports";

const prefs = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  ...DEFAULT_USER_PREFERENCES,
  ...overrides,
});

describe("notification preferences", () => {
  describe("isChannelEnabled", () => {
    it("maps each channel to its own preference flag", () => {
      const only = prefs({
        emailNotifications: false,
        smsNotifications: true,
        pushNotifications: false,
      });

      expect(isChannelEnabled(only, "sms")).toBe(true);
      expect(isChannelEnabled(only, "email")).toBe(false);
      expect(isChannelEnabled(only, "push")).toBe(false);
    });

    it("covers every registered channel", () => {
      // Guards the map in `notification-preferences.ts` against a channel added
      // to the port without a preference flag — which would otherwise read
      // `undefined` and disable the channel for everyone, silently.
      const all = prefs({
        emailNotifications: true,
        smsNotifications: true,
        pushNotifications: true,
      });

      for (const channel of NOTIFICATION_CHANNEL_NAMES) {
        expect(isChannelEnabled(all, channel)).toBe(true);
      }
    });
  });

  describe("selectChannels", () => {
    it("returns exactly the channels the user enabled", () => {
      const selected = selectChannels(
        prefs({ emailNotifications: true, smsNotifications: true, pushNotifications: false }),
        "marketing",
      );

      expect(selected).toEqual(["email", "sms"]);
    });

    it("uses the declared channel order, not the preference order", () => {
      const selected = selectChannels(
        prefs({ emailNotifications: true, smsNotifications: true, pushNotifications: true }),
        "marketing",
      );

      expect(selected).toEqual([...NOTIFICATION_CHANNEL_NAMES]);
    });

    it("selects nothing for marketing when every channel is off", () => {
      const selected = selectChannels(
        prefs({ emailNotifications: false, smsNotifications: false, pushNotifications: false }),
        "marketing",
      );

      expect(selected).toEqual([]);
    });

    it("falls back to email for a transactional message when every channel is off", () => {
      const selected = selectChannels(
        prefs({ emailNotifications: false, smsNotifications: false, pushNotifications: false }),
        "transactional",
      );

      expect(selected).toEqual([TRANSACTIONAL_FALLBACK_CHANNEL]);
    });

    it("does not apply the fallback while any channel survives", () => {
      // The fallback is a floor, not an override: someone who kept only push
      // gets push, and does not also get an email they turned off.
      const selected = selectChannels(
        prefs({ emailNotifications: false, smsNotifications: false, pushNotifications: true }),
        "transactional",
      );

      expect(selected).toEqual(["push"]);
    });

    it("respects the defaults a new account starts with", () => {
      expect(selectChannels(DEFAULT_USER_PREFERENCES, "marketing")).toEqual(["email"]);
    });

    it.each([
      [false, false, false],
      [false, false, true],
      [false, true, false],
      [false, true, true],
      [true, false, false],
      [true, false, true],
      [true, true, false],
      [true, true, true],
    ])(
      "never selects a disabled channel for marketing (email=%s sms=%s push=%s)",
      (emailNotifications, smsNotifications, pushNotifications) => {
        const preferences = prefs({
          emailNotifications,
          smsNotifications,
          pushNotifications,
        });

        for (const channel of selectChannels(preferences, "marketing")) {
          expect(isChannelEnabled(preferences, channel)).toBe(true);
        }
      },
    );
  });
});
