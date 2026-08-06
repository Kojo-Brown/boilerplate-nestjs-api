import { z } from "zod";
import { PAYMENT_PROVIDER_NAMES } from "@/payments/ports";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRY: z.string().default("15m"),
    JWT_REFRESH_EXPIRY: z.string().default("7d"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().optional(),
    ALLOWED_ORIGINS: z.string().default("*"),
    REDIS_URL: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    /** Which gateway `PaymentProviderFactory` hands out when none is named. */
    PAYMENTS_PROVIDER: z.enum(PAYMENT_PROVIDER_NAMES).default("mock"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_API_BASE_URL: z.string().url().default("https://api.stripe.com"),
    /**
     * Optional. Unset means Stripe uses the version pinned to the account,
     * which is the one its dashboard and webhooks already agree on; a dated
     * string Stripe does not recognise is a 400 on every request, so there is
     * no safe default to ship.
     */
    STRIPE_API_VERSION: z.string().optional(),
    PAYPAL_CLIENT_ID: z.string().optional(),
    PAYPAL_CLIENT_SECRET: z.string().optional(),
    PAYPAL_API_BASE_URL: z.string().url().default("https://api-m.sandbox.paypal.com"),

    /**
     * Notification channels. All optional: a channel without credentials
     * reports `isConfigured === false` and `NotificationDispatcher` skips it,
     * so a deployment with no Twilio account still sends email and push. Unlike
     * `PAYMENTS_PROVIDER` there is nothing to select here — the user's
     * preferences choose the channel, not the environment.
     */
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    /** E.164 sending number. Either this or a messaging service SID enables SMS. */
    TWILIO_FROM_NUMBER: z.string().optional(),
    /** `MG…`. Preferred over a bare number: Twilio then owns number pooling and opt-outs. */
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    TWILIO_API_BASE_URL: z.string().url().default("https://api.twilio.com"),

    /**
     * Expo's push endpoint accepts unauthenticated requests, which would let
     * anyone holding a device token push to that device. Supplying a token
     * opts into Expo's enhanced security; the push channel treats it as
     * required rather than optional for exactly that reason.
     */
    EXPO_ACCESS_TOKEN: z.string().optional(),
    EXPO_PUSH_API_BASE_URL: z.string().url().default("https://exp.host"),
  })
  /**
   * Selecting a gateway without its credentials is a deployment that boots
   * happily and fails at the first checkout. Catching it here turns that into
   * a startup error naming the missing variable — the same reason every other
   * setting in this file is validated rather than read with `??`.
   *
   * Only the *selected* provider is required to be complete: leaving PayPal
   * unconfigured while running on Stripe is a normal deployment, and the
   * factory refuses the incomplete one if anything asks for it by name.
   */
  .superRefine((env, ctx) => {
    if (env.PAYMENTS_PROVIDER === "stripe" && !env.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "STRIPE_SECRET_KEY is required when PAYMENTS_PROVIDER=stripe",
      });
    }

    if (env.PAYMENTS_PROVIDER === "paypal") {
      for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when PAYMENTS_PROVIDER=paypal`,
          });
        }
      }
    }

    /**
     * SMS is optional, but half-configured SMS is not: the channel needs an
     * account, a token and something to send from, and missing any one of them
     * makes it silently unavailable. Someone who set two of the three meant to
     * enable it, so say which one is missing at boot rather than let every SMS
     * be skipped as `not-configured` in production.
     */
    const twilio = {
      TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      sender: env.TWILIO_FROM_NUMBER ?? env.TWILIO_MESSAGING_SERVICE_SID,
    };
    if (Object.values(twilio).some(Boolean)) {
      for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when any other Twilio credential is set`,
          });
        }
      }
      if (!twilio.sender) {
        ctx.addIssue({
          code: "custom",
          path: ["TWILIO_FROM_NUMBER"],
          message:
            "TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required when any " +
            "other Twilio credential is set",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
