import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asRecord, readArray, readString, requestJson } from "@/common/http";
import { NotificationAddressRejectedError, NotificationChannelError } from "../notification.errors";
import type {
  Notification,
  NotificationChannel,
  NotificationChannelName,
  NotificationDelivery,
  NotificationRecipient,
} from "../ports";

/** `ExponentPushToken[…]` is the current form; `ExpoPushToken[…]` is the older one Expo still issues. */
const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

/**
 * Expo ticket errors that mean the token is dead and should be deleted, rather
 * than that this attempt failed.
 *
 * `DeviceNotRegistered` is the one that matters in practice — it is what an
 * uninstall looks like — and Expo is explicit that you must stop sending to
 * that token. `MismatchSenderId` and `InvalidCredentials` are configuration
 * faults that no retry fixes either, but they are not the address's fault, so
 * they stay transport errors.
 */
const DEAD_TOKEN_ERRORS = new Set(["DeviceNotRegistered"]);

/**
 * Push delivery through the Expo Push API.
 *
 * A single unauthenticated-by-default endpoint, `POST /--/api/v2/push/send`,
 * which is exactly why this channel treats `EXPO_ACCESS_TOKEN` as *required*
 * before it considers itself configured: without one, anyone who learns a
 * device's token can push to it, and Expo's own answer to that is the access
 * token this channel sends as a bearer credential. A boilerplate that shipped
 * push enabled and unauthenticated would be handing that footgun to every
 * project copied from it.
 *
 * A user may have several devices, and Expo takes a batch in one request, so
 * one `send()` is one HTTP call carrying every token. That means partial
 * success is normal: three tokens can come back two `ok` and one
 * `DeviceNotRegistered`. The delivery is reported successful if any ticket was
 * accepted, and only a batch where every ticket failed is an error — otherwise
 * one stale token from an old phone would suppress a notification the user's
 * current phone received.
 */
@Injectable()
export class PushNotificationChannel implements NotificationChannel {
  readonly channel: NotificationChannelName = "push";

  private readonly logger = new Logger(PushNotificationChannel.name);
  private readonly accessToken: string | null;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.accessToken = config.get<string>("EXPO_ACCESS_TOKEN") ?? null;
    this.baseUrl = config.get<string>("EXPO_PUSH_API_BASE_URL") ?? "https://exp.host";
  }

  get isConfigured(): boolean {
    return this.accessToken !== null;
  }

  /**
   * How many devices this recipient can be reached on, rather than any token
   * itself — a push token is a credential for reaching someone's phone and
   * does not belong in a delivery report or a log line.
   */
  addressFor(recipient: NotificationRecipient): string | null {
    const count = this.tokensFor(recipient).length;
    return count > 0 ? `${count} device${count === 1 ? "" : "s"}` : null;
  }

  async send(
    recipient: NotificationRecipient,
    notification: Notification,
  ): Promise<NotificationDelivery> {
    const tokens = this.tokensFor(recipient);
    if (tokens.length === 0) {
      throw new NotificationChannelError(
        this.channel,
        `No registered device tokens for user ${recipient.userId}`,
      );
    }
    const accessToken = this.requireAccessToken();

    const response = await requestJson(`${this.baseUrl}/--/api/v2/push/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: notification.title,
          body: notification.body,
          ...(notification.data ? { data: notification.data } : {}),
          // Transactional messages are the ones a user is waiting on, so they
          // get the delivery priority that wakes a sleeping device; marketing
          // can arrive with the next batch.
          priority: notification.category === "transactional" ? "high" : "normal",
        })),
      ),
    });

    const body = asRecord(response.body);

    if (!response.ok) {
      // Request-level failure: `{ "errors": [{ "code", "message" }] }`.
      const first = asRecord(readArray(body, "errors")[0]);
      throw new NotificationChannelError(
        this.channel,
        readString(first, "message") ?? `Expo responded ${response.status}`,
        readString(first, "code") ?? undefined,
      );
    }

    const tickets = readArray(body, "data").map(asRecord);
    if (tickets.length === 0) {
      throw new NotificationChannelError(this.channel, "Expo returned no push tickets");
    }

    const accepted = tickets.filter((ticket) => readString(ticket, "status") === "ok");
    if (accepted.length === 0) {
      const failure = tickets[0] ?? null;
      const detail = readString(asRecord(failure?.["details"]), "error");
      const message = readString(failure, "message") ?? "Expo rejected every push ticket";
      if (detail !== null && DEAD_TOKEN_ERRORS.has(detail)) {
        throw new NotificationAddressRejectedError(
          this.channel,
          this.addressFor(recipient) ?? "unknown",
          detail,
        );
      }
      throw new NotificationChannelError(this.channel, message, detail ?? undefined);
    }

    if (accepted.length < tickets.length) {
      // Not an error, but the caller should prune: some of these tokens are dead.
      this.logger.warn(
        `Expo rejected ${tickets.length - accepted.length} of ${tickets.length} push tokens for user ${recipient.userId}`,
      );
    }

    return {
      channel: this.channel,
      status: "sent",
      address: `${accepted.length} device${accepted.length === 1 ? "" : "s"}`,
      // The first ticket id. Expo receipts are fetched per ticket, so the full
      // set matters to a receipt poller; one id is what a delivery report needs
      // to find the batch in Expo's dashboard.
      providerMessageId: readString(accepted[0] ?? null, "id") ?? undefined,
    };
  }

  private tokensFor(recipient: NotificationRecipient): readonly string[] {
    return (recipient.deviceTokens ?? [])
      .map((token) => token.trim())
      .filter((token) => EXPO_PUSH_TOKEN.test(token));
  }

  private requireAccessToken(): string {
    if (!this.accessToken) {
      throw new NotificationChannelError(
        this.channel,
        "Push is not configured. Set EXPO_ACCESS_TOKEN.",
        undefined,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.accessToken;
  }
}
