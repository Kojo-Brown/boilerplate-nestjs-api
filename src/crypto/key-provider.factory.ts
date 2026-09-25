import { Logger } from "@nestjs/common";
import { EncryptionNotConfiguredError } from "./crypto.errors";
import type { KeyProvider, KeyProviderName } from "./ports";

/**
 * Picks the provider named by `ENCRYPTION_KEY_PROVIDER`, and refuses a selected
 * one that cannot work.
 *
 * A pure function rather than a class, because there is nothing to hold: unlike
 * `PaymentProviderFactory`, which hands out a different gateway per call, this
 * resolves once at boot and the result is bound to `KEY_PROVIDER`. Every
 * provider is still constructed, so the selection stays a runtime choice and a
 * deployment running on `local` need not have KMS configured.
 *
 * Refusing at boot is the whole reason this is not `providers.find(…) ?? first`.
 * A provider that is selected but unconfigured would otherwise fail at the first
 * write — which is the first *checkout* — and, worse, the failure would look like
 * a payments problem rather than a missing variable.
 */
export function selectKeyProvider(
  selected: KeyProviderName,
  providers: readonly KeyProvider[],
  nodeEnv: string | undefined = process.env["NODE_ENV"],
  logger: Pick<Logger, "log" | "warn"> = new Logger("KeyProvider"),
): KeyProvider {
  const provider = providers.find((candidate) => candidate.name === selected);
  if (!provider) {
    throw new Error(
      `No key provider named "${selected}" is registered. Add it to the providers array in ` +
        `crypto.module.ts — the module is the only place that knows which providers exist.`,
    );
  }

  if (!provider.isConfigured) {
    throw new EncryptionNotConfiguredError(provider.name, provider.requiredEnv);
  }

  // One line at boot, because "which key is this deployment encrypting under"
  // is the first question asked when a row will not decrypt, and the answer is
  // otherwise nowhere in the logs.
  logger.log(`Field encryption is using the "${provider.name}" key provider`);

  /**
   * The one warning in this module, and the reason it is a warning rather than a
   * refused boot is set out in `crypto.env.ts`: refusing would leave a
   * deployment that is not on AWS with a plaintext column rather than with a
   * better key.
   *
   * It says what is *not* bought, in the terms an auditor will use, because the
   * failure mode here is not technical — the cryptography is identical — it is
   * somebody believing they have a control they do not have.
   */
  if (provider.name === "local" && nodeEnv === "production") {
    logger.warn(
      "ENCRYPTION_KEY_PROVIDER=local in production: the master key is in this process's " +
        "environment, beside the ciphertext it protects, so a copied backup is protected and " +
        "anything that can read the environment is not. There is no per-use audit trail and no " +
        "rotation without a redeploy. Set ENCRYPTION_KEY_PROVIDER=kms with " +
        "ENCRYPTION_KMS_KEY_ID for a key this process never holds. See docs/field-encryption.md.",
    );
  }

  return provider;
}
