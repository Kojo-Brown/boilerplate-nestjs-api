# Notifications — the channel strategy

`src/notifications` exists to answer one question per message: _how do we reach
this user?_ The answer comes from the user's own preferences, not from the call
site and not from the environment, and everything else in the module is what it
takes to make that answer safe.

## The shape

```
src/notifications/
├── ports/notification-channel.port.ts  # NotificationChannel + NOTIFICATION_CHANNELS token
├── notification-preferences.ts         # preference flags → channel names (pure)
├── notification-dispatcher.service.ts  # the Context: selects, fans out, reports
├── notifications.module.ts             # the only file that names an implementation
├── notification.errors.ts              # HttpExceptions, so AllExceptionsFilter renders them
├── notification-channel.contract.ts    # the behavioural contract, run against all three
└── channels/
    ├── email-notification.channel.ts   # enqueues on the existing BullMQ email queue
    ├── sms-notification.channel.ts     # Twilio Programmable Messaging
    └── push-notification.channel.ts    # Expo Push API
```

## Using it

Inject the dispatcher, never a channel:

```ts
@Injectable()
export class OrdersService {
  constructor(private readonly notifications: NotificationDispatcher) {}

  async markShipped(order: Order, user: User) {
    const report = await this.notifications.notify(
      // Email comes off the row; phone and device tokens come from the caller
      // (see "What is not here").
      recipientFromUser(user, { phone: order.contactPhone }),
      {
        category: "transactional",
        title: "Your order has shipped",
        body: `Order ${order.reference} is on its way.`,
        data: { orderId: order.id },
      },
    );

    // Nothing throws. The report says what happened on each channel.
    if (report.delivered.length === 0) {
      this.logger.warn(`Nobody reached for order ${order.id}`, report.skipped);
    }
  }
}
```

`notify()` reads preferences from `USER_PREFERENCES_STORE` on every call, so an
unsubscribe that landed a second ago is honoured by the next message. If you
have already loaded them, `notifyWith(recipient, notification, preferences)`
skips the read.

## How a channel is selected

Four stages, each of which can drop a channel and record why:

| Stage | Question                         | Skip reason             |
| ----- | -------------------------------- | ----------------------- |
| 1     | Does the user want this channel? | `preference-disabled`   |
| 2     | Is it registered at all?         | — (logged as a warning) |
| 3     | Does it have credentials?        | `not-configured`        |
| 4     | Can it reach this recipient?     | `no-address`            |
| —     | Did the send succeed?            | `failed`                |

Surviving channels are attempted **concurrently and independently**. Each send
catches its own failure, so a Twilio outage neither aborts nor delays the email
beside it, and every outcome lands on the `DispatchReport` rather than in a
thrown exception. A caller sending a notification inside a transaction does not
need a `try`/`catch` to keep that transaction alive.

`not-configured` and `no-address` are kept apart deliberately. Both end in
"nothing sent", but the first is an operator's problem and the second is the
recipient's data — collapsing them makes an outage undebuggable from a log line.

## Preferences, and the one exemption

Each channel maps to one flag on `UserPreferences`:

| Channel | Flag                 | Default |
| ------- | -------------------- | ------- |
| `email` | `emailNotifications` | `true`  |
| `sms`   | `smsNotifications`   | `false` |
| `push`  | `pushNotifications`  | `false` |

The map in `notification-preferences.ts` is typed as a total record over
`NOTIFICATION_CHANNEL_NAMES`, so adding a channel without deciding how a user
opts out of it is a compile error rather than a channel that silently ignores
preferences for everyone.

The exemption: a **transactional** message whose user has switched off every
channel still goes out by email. A password reset or a security alert nobody
receives is not a respected preference, it is a support ticket, and in most
jurisdictions transactional contact is not the kind a user can opt out of. The
rule is a floor, not an override — someone who kept only push gets push, and
does _not_ also get the email they turned off. `marketing` has no exemption: opt
out of everything and nothing is sent.

Email is the fallback because it is the one address every account has —
registration requires it, OAuth sign-in supplies it, and unlike a device token
it does not expire when someone reinstalls an app.

## `sent` versus `queued`

`NotificationDelivery.status` distinguishes them, and the distinction is real.
SMS and push hand the message to a third party synchronously and report `sent`.
Email hands it to our own BullMQ queue and reports `queued` — the worker has not
run yet. A caller that tells a user "we emailed you" off the back of a `queued`
result is claiming something that has not happened.

Email goes through the queue rather than calling a mail API directly so that
retries, backoff and the eventual mail provider stay in `EmailProcessor`.
Duplicating them here would mean a notification email and a password-reset email
retried under different rules.

## Configuration

Every channel is optional. One without credentials reports
`isConfigured === false` and is skipped, so an app with no Twilio account still
delivers email and push. Unlike `PAYMENTS_PROVIDER`, nothing here _selects_ a
channel — the user's preferences do.

| Variable                                                   | Channel | Notes                                                                                                |
| ---------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`                  | sms     | Both required together                                                                               |
| `TWILIO_FROM_NUMBER` **or** `TWILIO_MESSAGING_SERVICE_SID` | sms     | A messaging service (`MG…`) is the production-shaped option: Twilio owns number pooling and opt-outs |
| `TWILIO_API_BASE_URL`                                      | sms     | Defaults to `https://api.twilio.com`                                                                 |
| `EXPO_ACCESS_TOKEN`                                        | push    | **Required** for push to be considered configured                                                    |
| `EXPO_PUSH_API_BASE_URL`                                   | push    | Defaults to `https://exp.host`                                                                       |

Half-configured SMS is a boot failure: setting two of the three means someone
meant to enable it, and booting anyway would make every SMS silently
`not-configured` in production. The Zod schema names the missing variable.

`EXPO_ACCESS_TOKEN` is required rather than optional on purpose. Expo's push
endpoint accepts unauthenticated requests, so without a token anyone who learns
a device's token can push to that device; the token is Expo's own answer to
that. A boilerplate that shipped push enabled and unauthenticated would hand
that footgun to every project copied from it.

## Adding a channel

1. Implement `NotificationChannel` in `channels/`.
2. Add its name to `NOTIFICATION_CHANNEL_NAMES` and a flag to `UserPreferences`;
   the compiler will point at the preference map until you map the two.
3. Register the class in `notifications.module.ts` — in `providers` and in the
   `NOTIFICATION_CHANNELS` `inject` list.
4. Add one line to `notification-channel.contract.spec.ts`.

`NotificationDispatcher` does not change, and neither does any caller.

## Testing

`notification-channel.contract.ts` holds the behavioural contract and
`notification-channel.contract.spec.ts` runs it against all three channels. The
type system checks four signatures; what actually breaks a notification is
behaviour — a channel that returns `undefined` where another returns `null`, one
that reports `sent` for something it only queued, one that invents an address
for a recipient it cannot reach.

The two HTTP channels are driven by in-process fakes of the real APIs
(`FakeTwilioApi`, `FakeExpoPushApi`) rather than by mocking `fetch`. The fakes
enforce the parts of each contract the channel depends on — HTTP basic auth and
form encoding for Twilio, bearer auth and one ticket per message for Expo — so a
channel that gets any of them wrong fails in CI rather than in production. The
Expo fake in particular returns a ticket per token, which is the only way the
partial-failure paths get exercised at all.

## What is not here

- **Contact storage.** The `User` model has an email column and nothing else: no
  `phone`, no device-token table. `NotificationRecipient` therefore takes those
  addresses from the caller, funnelled through `recipientFromUser` so the gap
  lives in one documented place. Adding the columns is a migration plus a change
  to that function, not a change to any channel.
- **Delivery receipts.** Twilio and Expo both report final delivery
  asynchronously — a status webhook and a receipts endpoint respectively. This
  module reports what the transport accepted, which is not the same as what the
  device received.
- **Templating and localisation.** `title` and `body` arrive composed.
  `UserPreferences.language` exists but nothing here reads it.
- **Batching and rate limits.** One `notify()` is one user. Expo's 100-message
  batch limit and Twilio's per-account throughput are not managed here.
