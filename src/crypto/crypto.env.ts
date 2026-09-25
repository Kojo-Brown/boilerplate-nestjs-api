import type { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { decodeMasterKey, LOCAL_MASTER_KEY_ENV } from "./adapters/local-master-key.key-provider";
import { KMS_KEY_ID_ENV } from "./adapters/aws-kms.key-provider";
import { KEY_PROVIDER_NAMES } from "./ports";

/**
 * The maximum number of values one data key may encrypt.
 *
 * 2^32, which is the limit NIST SP 800-38D puts on invocations of GCM under one
 * key when the IV is random rather than a counter. It is not a performance
 * number: past it, the chance that two values share a 96-bit IV under the same
 * key stops being negligible, and a repeated IV in GCM leaks the authentication
 * subkey rather than merely one plaintext.
 */
export const MAX_DATA_KEY_USES = 2 ** 32;

/**
 * The longest a data key may stay resident, in seconds.
 *
 * An hour. The TTL is what bounds how long this process can still read rows
 * after its KMS grant is revoked, and how long a memory compromise keeps paying
 * — both of which are incident-response numbers, and an incident lasting longer
 * than the key that is supposed to have been cut off is the failure mode.
 */
export const MAX_DATA_KEY_TTL_SECONDS = 3600;

/**
 * The field-encryption half of the environment, as a shape rather than a schema.
 *
 * Spread into `envSchema` the same way `securityEnvShape` and `mtlsEnvShape` are,
 * and for the sharpest version of their shared argument: every mistake here is
 * silent in one direction. A deployment configured with the wrong key encrypts
 * perfectly and cannot read a single row written under the right one, and it
 * finds out at the first read rather than at boot. So the checks happen while
 * there is still nothing to lose.
 */
export const cryptoEnvShape = {
  /**
   * Where data keys come from.
   *
   * Defaults to `local` so a clean clone boots and the test suites run with no
   * AWS account, the same default `STORAGE_ADAPTER` and `PAYMENTS_PROVIDER` take.
   *
   * Unlike `STORAGE_ADAPTER=memory`, `local` is **not** refused in production,
   * and that is a deliberate departure from the pattern. The in-memory store is
   * refused because it silently loses data, so the choice there is between a
   * working deployment and a broken one. Here the choice is between imperfect
   * encryption and a plaintext column: a deployment that is not on AWS, and
   * would be refused, does not go and buy a KMS — it leaves the data in the
   * clear. A master key from an injected secret still defends against the
   * threats this feature is actually bought for (a copied backup, a read
   * replica, a dump in a ticket), and it is the same operational model this
   * codebase already accepts for `JWT_SECRET`, which sits beside it.
   *
   * What it does not defend against is named in the warning `selectKeyProvider`
   * logs at boot, and at more length in `docs/field-encryption.md`.
   */
  ENCRYPTION_KEY_PROVIDER: z.enum(KEY_PROVIDER_NAMES).default("local"),

  /**
   * The master key for `ENCRYPTION_KEY_PROVIDER=local`: 32 bytes, base64.
   *
   * `openssl rand -base64 32`. THIS IS A CREDENTIAL — it belongs wherever
   * `JWT_SECRET` lives. There is deliberately no default: a generated-per-boot
   * key would work beautifully until the first restart and then leave every row
   * written before it unreadable, with nothing logged anywhere.
   */
  ENCRYPTION_LOCAL_MASTER_KEY: z.string().optional(),

  /**
   * The KMS key for `ENCRYPTION_KEY_PROVIDER=kms`: a key id, an
   * `alias/…`, or a full ARN.
   *
   * An alias is usually the right answer, because it is what makes a key
   * rotation an operator action rather than a deploy: point the alias at the new
   * key and new data keys are wrapped under it, while old rows keep unwrapping
   * under the key their blob names. A full ARN also tells this service which
   * region the key is in, so it needs no second variable.
   */
  ENCRYPTION_KMS_KEY_ID: z.string().optional(),

  /**
   * The region to call KMS in. Optional, and only needed for a bare key id or an
   * alias: an ARN names its own region, and otherwise the SDK's own resolution
   * (`AWS_REGION`, then instance metadata) applies.
   */
  ENCRYPTION_KMS_REGION: z.string().optional(),

  /**
   * How long a data key may be used and kept, in seconds.
   *
   * Five minutes. Long enough that a burst of traffic makes one KMS call rather
   * than thousands, short enough that revoking this service's grant takes effect
   * inside a coffee break. See {@link MAX_DATA_KEY_TTL_SECONDS}.
   */
  ENCRYPTION_DATA_KEY_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /** How many values one data key may encrypt. See {@link MAX_DATA_KEY_USES}. */
  ENCRYPTION_DATA_KEY_MAX_USES: z.coerce.number().int().positive().default(10_000),

  /**
   * How many distinct wrapped keys to keep unwrapped for reads.
   *
   * Every row carries the key it was written under, so this is really "how many
   * key generations can be read without a KMS call". 500 covers a long history
   * at the default TTL and is a few tens of kilobytes of key material.
   */
  ENCRYPTION_DATA_KEY_CACHE_SIZE: z.coerce.number().int().positive().default(500),
} as const;

const cryptoEnvSchema = z.object(cryptoEnvShape);

/** The parsed encryption settings, as the rest of the module receives them. */
export type CryptoEnv = z.infer<typeof cryptoEnvSchema>;

/**
 * Reads the encryption settings back out of the validated configuration.
 *
 * The same arrangement, for the same reason, as `securityEnvFrom`:
 * `ConfigModule.forRoot({ validate })` stores what `envSchema` returned, so the
 * values here are already coerced and already refined and the re-parse is a type
 * boundary rather than a second validation.
 *
 * It exists so the defaults are written once. `FieldEncryptionService` used to
 * read three keys with its own `?? 300`-style fallbacks, which is two places for
 * every default and therefore two places for them to disagree — and the one that
 * would win is the one an operator never sees in `.env.example`.
 */
export function cryptoEnvFrom(config: Pick<ConfigService, "get">): CryptoEnv {
  const raw = Object.fromEntries(Object.keys(cryptoEnvShape).map((key) => [key, config.get(key)]));

  return cryptoEnvSchema.parse(raw);
}

/**
 * Cross-field checks for the encryption settings, applied by `envSchema`'s
 * `superRefine` and kept next to the shape so the rules travel with the
 * variables.
 *
 * `_nodeEnv` is taken and unused, unlike in the security and mTLS refinements
 * next door. Nothing here is refused only in production, on purpose: see
 * `ENCRYPTION_KEY_PROVIDER` above for why `local` is a warning rather than a
 * refusal there. The parameter stays so the three refinements are called the
 * same way and a future production-only rule has somewhere to go.
 */
export function refineCryptoEnv(
  env: CryptoEnv,
  _nodeEnv: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (env.ENCRYPTION_KEY_PROVIDER === "local") {
    const raw = env.ENCRYPTION_LOCAL_MASTER_KEY;
    if (raw === undefined || raw.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: [LOCAL_MASTER_KEY_ENV],
        message:
          `${LOCAL_MASTER_KEY_ENV} is required when ENCRYPTION_KEY_PROVIDER=local. Generate one ` +
          `with \`openssl rand -base64 32\` and keep it wherever JWT_SECRET lives — a key ` +
          `generated at boot instead would make every row written before the next restart ` +
          `unreadable.`,
      });
    } else if (decodeMasterKey(raw) === null) {
      ctx.addIssue({
        code: "custom",
        path: [LOCAL_MASTER_KEY_ENV],
        message:
          `${LOCAL_MASTER_KEY_ENV} is not 32 bytes of base64. Base64 decoding ignores ` +
          `characters outside its alphabet, so a truncated or mistyped secret would otherwise ` +
          `be accepted as a *different* key: it encrypts fine and cannot read anything written ` +
          `under the intended one. All-zero keys are refused too, because that is what an ` +
          `unexpanded placeholder produces.`,
      });
    }
  }

  if (env.ENCRYPTION_KEY_PROVIDER === "kms" && !env.ENCRYPTION_KMS_KEY_ID) {
    ctx.addIssue({
      code: "custom",
      path: [KMS_KEY_ID_ENV],
      message:
        `${KMS_KEY_ID_ENV} is required when ENCRYPTION_KEY_PROVIDER=kms — the same reason ` +
        `S3_BUCKET is required for STORAGE_ADAPTER=s3: otherwise this boots happily and fails ` +
        `on the first write.`,
    });
  }

  if (env.ENCRYPTION_DATA_KEY_TTL_SECONDS > MAX_DATA_KEY_TTL_SECONDS) {
    ctx.addIssue({
      code: "custom",
      path: ["ENCRYPTION_DATA_KEY_TTL_SECONDS"],
      message:
        `ENCRYPTION_DATA_KEY_TTL_SECONDS is capped at ${MAX_DATA_KEY_TTL_SECONDS}. The TTL is ` +
        `how long this process can still read rows after its KMS grant is revoked, so a value ` +
        `measured in days means a key you cannot actually cut off.`,
    });
  }

  if (env.ENCRYPTION_DATA_KEY_MAX_USES > MAX_DATA_KEY_USES) {
    ctx.addIssue({
      code: "custom",
      path: ["ENCRYPTION_DATA_KEY_MAX_USES"],
      message:
        `ENCRYPTION_DATA_KEY_MAX_USES is capped at ${MAX_DATA_KEY_USES} (2^32), the limit NIST ` +
        `SP 800-38D sets on GCM invocations under one key with a random IV. Past it, two values ` +
        `sharing a 96-bit IV stops being negligible, and a repeated IV in GCM costs the ` +
        `authentication subkey rather than one plaintext.`,
    });
  }
}
