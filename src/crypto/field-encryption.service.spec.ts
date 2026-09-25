import { randomBytes } from "crypto";
import { LocalMasterKeyProvider } from "./adapters/local-master-key.key-provider";
import { EnvelopeFormatError, FieldDecryptionError } from "./crypto.errors";
import { encryptedField } from "./encrypted-field";
import { FieldEncryptionService } from "./field-encryption.service";
import { createTestFieldEncryption } from "@/test-utils/test-field-encryption";
import { stubConfig } from "@/test-utils/stub-config";

const ORDERS = encryptedField("orders", "itemsCiphertext");
const USERS = encryptedField("users", "phoneCiphertext");

const LINES = [
  { sku: "SKU-DESK-01", quantity: 2, unitPriceMinor: 34_900 },
  { sku: "SKU-LAMP-03", quantity: 1, unitPriceMinor: 4_250 },
];

describe("FieldEncryptionService", () => {
  let cipher: FieldEncryptionService;

  beforeEach(() => {
    cipher = createTestFieldEncryption();
  });

  it("round-trips a JSON value", async () => {
    const stored = await cipher.encryptJson(ORDERS, "order-1", LINES);

    expect(await cipher.decryptJson(ORDERS, "order-1", stored)).toEqual(LINES);
  });

  it("round-trips a string", async () => {
    const stored = await cipher.encrypt(ORDERS, "order-1", Buffer.from("+44 7700 900123", "utf8"));

    expect((await cipher.decrypt(ORDERS, "order-1", stored)).toString("utf8")).toBe(
      "+44 7700 900123",
    );
  });

  it("stores nothing a grep would find", async () => {
    const stored = await cipher.encryptJson(ORDERS, "order-1", LINES);

    expect(stored.includes("SKU-DESK-01")).toBe(false);
    expect(stored.includes("34900")).toBe(false);
    expect(stored.toString("utf8")).not.toContain("sku");
  });

  it("refuses to decrypt a value under another record's id", async () => {
    // The attack this closes: whoever can write the database copies a victim's
    // ciphertext onto a row they own and asks the application to render it.
    const stored = await cipher.encryptJson(ORDERS, "order-1", LINES);

    await expect(cipher.decryptJson(ORDERS, "order-2", stored)).rejects.toThrow(
      FieldDecryptionError,
    );
  });

  it("refuses to decrypt a value under another column", async () => {
    const stored = await cipher.encryptJson(ORDERS, "record-1", LINES);

    await expect(cipher.decryptJson(USERS, "record-1", stored)).rejects.toThrow(
      FieldDecryptionError,
    );
  });

  it("refuses a value written under another master key", async () => {
    const stored = await createTestFieldEncryption().encryptJson(ORDERS, "order-1", LINES);

    await expect(cipher.decryptJson(ORDERS, "order-1", stored)).rejects.toThrow(
      FieldDecryptionError,
    );
  });

  it("names the field and the record when it cannot decrypt, and never the value", async () => {
    const stored = await cipher.encryptJson(ORDERS, "order-1", LINES);

    const failure: FieldDecryptionError = await cipher.decryptJson(ORDERS, "order-2", stored).then(
      () => {
        throw new Error("decrypting another record's value resolved");
      },
      (error: unknown) => error as FieldDecryptionError,
    );

    expect(failure.message).toContain("orders.itemsCiphertext");
    expect(failure.message).toContain("order-2");
    expect(failure.message).not.toContain("SKU-DESK-01");
    expect(failure.cause).toBeDefined();
  });

  it("reports bytes that are not an envelope as a format problem, not a key problem", async () => {
    // The distinction matters: one sends an operator to look at KMS and the other
    // at a migration.
    await expect(
      cipher.decryptJson(ORDERS, "order-1", Buffer.from("plain old jsonb", "utf8")),
    ).rejects.toThrow(EnvelopeFormatError);
  });

  it("reports an authenticated value that is not JSON as a decryption failure", async () => {
    const stored = await cipher.encrypt(ORDERS, "order-1", Buffer.from("{not json", "utf8"));

    await expect(cipher.decryptJson(ORDERS, "order-1", stored)).rejects.toThrow(
      FieldDecryptionError,
    );
  });

  it("keeps reading rows written under earlier data keys", async () => {
    // The property the envelope format buys: the key travels with the value, so a
    // key retired an hour ago is still the key that row names.
    const first = await cipher.encryptJson(ORDERS, "order-1", LINES);
    const second = await cipher.encryptJson(ORDERS, "order-2", [LINES[0]]);
    cipher.clearKeyCache();
    const third = await cipher.encryptJson(ORDERS, "order-3", []);

    expect(await cipher.decryptJson(ORDERS, "order-1", first)).toEqual(LINES);
    expect(await cipher.decryptJson(ORDERS, "order-2", second)).toEqual([LINES[0]]);
    expect(await cipher.decryptJson(ORDERS, "order-3", third)).toEqual([]);
  });

  it("uses one data key across records, so a page of writes is not a page of KMS calls", async () => {
    const provider = new LocalMasterKeyProvider(
      stubConfig({ ENCRYPTION_LOCAL_MASTER_KEY: randomBytes(32).toString("base64") }),
    );
    const generate = jest.spyOn(provider, "generateDataKey");
    const service = new FieldEncryptionService(provider, stubConfig({}));

    await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        service.encryptJson(ORDERS, `order-${index}`, LINES),
      ),
    );

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("unwraps once for a page of rows written together", async () => {
    const provider = new LocalMasterKeyProvider(
      stubConfig({ ENCRYPTION_LOCAL_MASTER_KEY: randomBytes(32).toString("base64") }),
    );
    const service = new FieldEncryptionService(provider, stubConfig({}));
    const rows = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        service
          .encryptJson(ORDERS, `order-${index}`, LINES)
          .then((stored) => ({ id: `order-${index}`, stored })),
      ),
    );
    service.clearKeyCache();
    const unwrap = jest.spyOn(provider, "unwrapDataKey");

    await Promise.all(rows.map((row) => service.decryptJson(ORDERS, row.id, row.stored)));

    expect(unwrap).toHaveBeenCalledTimes(1);
  });

  it("retires a data key before its use budget runs out", async () => {
    const provider = new LocalMasterKeyProvider(
      stubConfig({ ENCRYPTION_LOCAL_MASTER_KEY: randomBytes(32).toString("base64") }),
    );
    const generate = jest.spyOn(provider, "generateDataKey");
    const service = new FieldEncryptionService(provider, stubConfig({}), {
      maxUses: 4,
      refreshFraction: 0.75,
    });

    for (let index = 0; index < 8; index += 1) {
      await service.encryptJson(ORDERS, `order-${index}`, LINES);
    }

    // Three keys for eight values, not two: with a budget of four the
    // replacement starts on the *third* use, so the key in hand is always one
    // with headroom and no caller ever waits for the key manager. Eight values
    // under a budget of four would be two keys only if a key were replaced at
    // the moment it ran out — which is exactly the arrangement that puts a KMS
    // round trip inside whichever transaction happens to be open. Buying that
    // with a few extra data keys is the trade.
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("prepares a key before anything is written", async () => {
    const provider = new LocalMasterKeyProvider(
      stubConfig({ ENCRYPTION_LOCAL_MASTER_KEY: randomBytes(32).toString("base64") }),
    );
    const generate = jest.spyOn(provider, "generateDataKey");
    const service = new FieldEncryptionService(provider, stubConfig({}));

    await service.prepare(ORDERS);
    await service.encryptJson(ORDERS, "order-1", LINES);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(service.providerName).toBe("local");
  });

  it("refuses to encrypt without a record id", async () => {
    await expect(cipher.encryptJson(ORDERS, "", LINES)).rejects.toThrow(/without the id/);
  });
});
