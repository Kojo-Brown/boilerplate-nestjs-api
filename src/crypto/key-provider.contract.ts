import { DataKeyUnwrapError } from "./crypto.errors";
import { DATA_KEY_BYTES } from "./ports";
import type { EncryptionContext, KeyProvider } from "./ports";

/**
 * The behavioural contract every key provider must satisfy.
 *
 * `CryptoModule` binds one of them at runtime, so `FieldEncryptionService` — and
 * therefore every encrypted column — has to work identically whichever it gets
 * (LSP). The type system checks two signatures; what actually loses data is
 * behaviour, and specifically the behaviour around *refusal*: a provider that
 * unwraps a key under an encryption context it was not wrapped under has quietly
 * removed the control that keeps a value from being readable on another column,
 * and nothing anywhere would say so.
 *
 * So the contract lives here once and `key-provider.contract.spec.ts` runs it
 * against both implementations, the KMS one driven by an in-process fake of the
 * real API. Adding a provider means adding one line there.
 */
const CONTEXT: EncryptionContext = {
  purpose: "field-encryption-v1",
  table: "orders",
  column: "itemsCiphertext",
};

const OTHER_CONTEXT: EncryptionContext = { ...CONTEXT, column: "somethingElse" };

export function describeKeyProviderContract(name: string, createProvider: () => KeyProvider): void {
  describe(`${name} (key provider contract)`, () => {
    let provider: KeyProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it("reports itself configured, or the contract below means nothing", () => {
      expect(provider.isConfigured).toBe(true);
      expect(provider.requiredEnv.length).toBeGreaterThan(0);
    });

    it("mints an AES-256 key and a wrapped form that is not it", async () => {
      const key = await provider.generateDataKey(CONTEXT);

      expect(key.plaintext).toHaveLength(DATA_KEY_BYTES);
      expect(key.wrapped.length).toBeGreaterThan(0);
      // The check that catches a provider that "wraps" by copying. It has
      // happened, in other people's code, and every test that only asserted a
      // round trip passed.
      expect(key.wrapped.includes(key.plaintext)).toBe(false);
    });

    it("never mints the same key twice", async () => {
      const [first, second] = await Promise.all([
        provider.generateDataKey(CONTEXT),
        provider.generateDataKey(CONTEXT),
      ]);

      expect(first.plaintext.equals(second.plaintext)).toBe(false);
      expect(first.wrapped.equals(second.wrapped)).toBe(false);
    });

    it("round-trips a wrapped key under the same context", async () => {
      const key = await provider.generateDataKey(CONTEXT);

      const unwrapped = await provider.unwrapDataKey(key.wrapped, CONTEXT);

      expect(unwrapped.equals(key.plaintext)).toBe(true);
    });

    it("refuses a wrapped key under a different context", async () => {
      // The property that makes the encryption context a control rather than a
      // label: a wrapped key lifted out of one column cannot be presented as
      // another's, even by something holding the whole database.
      const key = await provider.generateDataKey(CONTEXT);

      await expect(provider.unwrapDataKey(key.wrapped, OTHER_CONTEXT)).rejects.toThrow(
        DataKeyUnwrapError,
      );
    });

    it("refuses a wrapped key with a byte changed", async () => {
      const key = await provider.generateDataKey(CONTEXT);
      const tampered = Buffer.from(key.wrapped);
      // The last byte is in the ciphertext of the wrapped key for both
      // providers, which is what makes this a forgery rather than a malformed
      // blob — the framing still parses.
      tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);

      await expect(provider.unwrapDataKey(tampered, CONTEXT)).rejects.toThrow(DataKeyUnwrapError);
    });

    it("refuses something that is not a wrapped key at all", async () => {
      await expect(
        provider.unwrapDataKey(Buffer.from("not a wrapped key", "utf8"), CONTEXT),
      ).rejects.toThrow(DataKeyUnwrapError);
    });

    it("refuses an empty blob rather than treating it as a key", async () => {
      await expect(provider.unwrapDataKey(Buffer.alloc(0), CONTEXT)).rejects.toThrow(
        DataKeyUnwrapError,
      );
    });
  });
}
