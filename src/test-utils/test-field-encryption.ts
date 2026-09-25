import { randomBytes } from "crypto";
import { LocalMasterKeyProvider } from "@/crypto";
import { FieldEncryptionService } from "@/crypto/field-encryption.service";
import type { DataKeyCacheOptions } from "@/crypto/data-key-cache";
import { stubConfig } from "./stub-config";

export interface TestFieldEncryptionOptions {
  /**
   * The master key, so two services in one suite can share one.
   *
   * That matters more than it looks: a spec that builds two stores with two
   * random master keys writes rows one of them cannot read, and the failure
   * arrives as "could not decrypt" several assertions later.
   */
  readonly masterKey?: Buffer;
  readonly cache?: Partial<DataKeyCacheOptions>;
}

/**
 * A real `FieldEncryptionService` on the local key provider.
 *
 * Not a stub, and deliberately not one. The local provider produces byte-for-byte
 * the same envelope the KMS provider does, with the same authenticated data, so
 * a spec asserting that a ciphertext will not decrypt on another row is
 * asserting a property of the production path rather than of a fake. What it
 * avoids is the network, not the cryptography — the same bargain
 * `FakeS3Api` makes.
 */
export function createTestFieldEncryption(
  options: TestFieldEncryptionOptions = {},
): FieldEncryptionService {
  const masterKey = options.masterKey ?? randomBytes(32);
  const config = stubConfig({
    ENCRYPTION_LOCAL_MASTER_KEY: masterKey.toString("base64"),
    ENCRYPTION_DATA_KEY_TTL_SECONDS: 300,
    ENCRYPTION_DATA_KEY_MAX_USES: 10_000,
    ENCRYPTION_DATA_KEY_CACHE_SIZE: 100,
  });

  return new FieldEncryptionService(new LocalMasterKeyProvider(config), config, options.cache);
}

/** A fresh 32-byte master key, for a suite that needs two services to share one. */
export function testMasterKey(): Buffer {
  return randomBytes(32);
}
