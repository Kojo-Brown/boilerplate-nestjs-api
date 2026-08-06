import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asRecord, readNumber, readString, requestJson } from "@/common/http";
import { NotificationAddressRejectedError, NotificationChannelError } from "../notification.errors";
import type {
  Notification,
  NotificationChannel,
  NotificationChannelName,
  NotificationDelivery,
  NotificationRecipient,
} from "../ports";

/**
 * E.164: a leading `+`, a country code that cannot start with zero, then up to
 * fourteen more digits. Twilio rejects anything else with error 21211, so
 * checking here turns a billed round-trip into a `no-address` skip.
 */
const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * Twilio error codes that mean "this number will never work", as opposed to
 * "something went wrong just now".
 *
 * 21211 invalid `To`, 21610 the recipient replied STOP, 21614 not SMS-capable,
 * 21408 the account has no permission to message that region. Retrying any of
 * them costs another API call and fails identically, so they surface as an
 * address rejection the caller can act on rather than a transport error.
 */
const PERMANENT_ADDRESS_ERRORS = new Set([21211, 21610, 21614, 21408]);

/** Twilio message statuses that mean the message never left. */
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "undelivered", "canceled"]);

/**
 * SMS delivery through Twilio's Programmable Messaging API.
 *
 * One endpoint — `POST /2010-04-01/Accounts/{sid}/Messages.json`, HTTP basic
 * auth, form-encoded — so it is a `fetch` client rather than the vendor SDK,
 * consistent with the payment gateways and, more usefully, drivable end to end
 * by `FakeTwilioApi` in the contract suite.
 *
 * SMS has no subject line and no structured payload, so `title` is folded into
 * the body and `data` is dropped. Doing that here rather than asking callers to
 * write channel-specific copy is what keeps one `notify()` call able to fan out
 * to three transports.
 */
@Injectable()
export class SmsNotificationChannel implements NotificationChannel {
  readonly channel: NotificationChannelName = "sms";

  private readonly logger = new Logger(SmsNotificationChannel.name);
  private readonly accountSid: string | null;
  private readonly authToken: string | null;
  private readonly from: string | null;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.accountSid = config.get<string>("TWILIO_ACCOUNT_SID") ?? null;
    this.authToken = config.get<string>("TWILIO_AUTH_TOKEN") ?? null;
    // A messaging service SID is the production-shaped option — Twilio picks the
    // sending number from a pool and handles opt-outs — but a bare number is
    // what a trial account has, so both are accepted and either satisfies the
    // `From` requirement.
    this.from =
      config.get<string>("TWILIO_MESSAGING_SERVICE_SID") ??
      config.get<string>("TWILIO_FROM_NUMBER") ??
      null;
    this.baseUrl = config.get<string>("TWILIO_API_BASE_URL") ?? "https://api.twilio.com";
  }

  get isConfigured(): boolean {
    return Boolean(this.accountSid && this.authToken && this.from);
  }

  addressFor(recipient: NotificationRecipient): string | null {
    const phone = recipient.phone?.trim();
    return phone && E164.test(phone) ? phone : null;
  }

  async send(
    recipient: NotificationRecipient,
    notification: Notification,
  ): Promise<NotificationDelivery> {
    const to = this.addressFor(recipient);
    if (!to) {
      throw new NotificationChannelError(
        this.channel,
        `No E.164 phone number for user ${recipient.userId}`,
      );
    }
    const { accountSid, authToken, from } = this.credentials();

    const form = new URLSearchParams({
      To: to,
      Body: composeSms(notification),
      // Twilio distinguishes the two by prefix: `MG…` is a messaging service,
      // anything else is treated as a sending number.
      ...(from.startsWith("MG") ? { MessagingServiceSid: from } : { From: from }),
    });

    const response = await requestJson(
      `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      },
    );

    const body = asRecord(response.body);

    if (!response.ok) {
      const code = readNumber(body, "code");
      const message = readString(body, "message") ?? `Twilio responded ${response.status}`;
      if (code !== null && PERMANENT_ADDRESS_ERRORS.has(code)) {
        throw new NotificationAddressRejectedError(this.channel, to, `${code} ${message}`);
      }
      throw new NotificationChannelError(this.channel, message, code?.toString());
    }

    const status = readString(body, "status");
    if (status !== null && TERMINAL_FAILURE_STATUSES.has(status)) {
      // A 201 with `status: failed` happens — Twilio validates some things
      // after accepting the resource. Reporting it as sent would be wrong.
      const errorCode = readNumber(body, "error_code");
      const errorMessage = readString(body, "error_message") ?? `Twilio status "${status}"`;
      if (errorCode !== null && PERMANENT_ADDRESS_ERRORS.has(errorCode)) {
        throw new NotificationAddressRejectedError(
          this.channel,
          to,
          `${errorCode} ${errorMessage}`,
        );
      }
      throw new NotificationChannelError(this.channel, errorMessage, errorCode?.toString());
    }

    const sid = readString(body, "sid");
    if (!sid) {
      throw new NotificationChannelError(this.channel, "Twilio accepted the message without a SID");
    }

    this.logger.debug(`Sent SMS ${sid} to ${redactPhone(to)}`);
    return {
      channel: this.channel,
      status: "sent",
      // Redacted, because a delivery report is logged and returned to callers
      // and a full phone number does not need to be in either.
      address: redactPhone(to),
      providerMessageId: sid,
    };
  }

  private credentials(): { accountSid: string; authToken: string; from: string } {
    if (!this.accountSid || !this.authToken || !this.from) {
      throw new NotificationChannelError(
        this.channel,
        "SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and " +
          "TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.",
        undefined,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { accountSid: this.accountSid, authToken: this.authToken, from: this.from };
  }
}

/**
 * A single GSM-7 segment is 160 characters and every segment past the first is
 * billed separately, so the body is truncated rather than allowed to fan out
 * into an unbounded number of messages. 320 leaves room for two segments, which
 * is enough for a title plus a sentence.
 */
const SMS_MAX_LENGTH = 320;

export function composeSms(notification: Notification): string {
  const text = `${notification.title}: ${notification.body}`;
  return text.length <= SMS_MAX_LENGTH ? text : `${text.slice(0, SMS_MAX_LENGTH - 1)}…`;
}

/** `+15551234567` → `+1555•••4567`. Enough to identify a number in a log, not enough to dial it. */
export function redactPhone(phone: string): string {
  if (phone.length <= 8) return phone;
  return `${phone.slice(0, 4)}•••${phone.slice(-4)}`;
}
