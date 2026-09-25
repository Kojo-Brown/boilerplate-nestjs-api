import { randomBytes } from "crypto";
import { AwsKmsKeyProvider } from "./adapters/aws-kms.key-provider";
import { LocalMasterKeyProvider } from "./adapters/local-master-key.key-provider";
import { describeKeyProviderContract } from "./key-provider.contract";
import { DataKeyUnwrapError, KeyProviderError } from "./crypto.errors";
import { FakeKmsApi } from "@/test-utils/fake-kms-api";
import { stubConfig } from "@/test-utils/stub-config";

const MASTER_KEY = randomBytes(32).toString("base64");

describeKeyProviderContract(
  "LocalMasterKeyProvider",
  () => new LocalMasterKeyProvider(stubConfig({ ENCRYPTION_LOCAL_MASTER_KEY: MASTER_KEY })),
);

describeKeyProviderContract("AwsKmsKeyProvider", () => {
  const api = new FakeKmsApi();
  const keyId = api.createKey();

  return new AwsKmsKeyProvider(stubConfig({ ENCRYPTION_KMS_KEY_ID: keyId }), {
    requestHandler: api.requestHandler,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
});

/**
 * What only one of them can be asked, because it is about KMS's API rather than
 * about the shape of the port.
 */
describe("AwsKmsKeyProvider", () => {
  const providerFor = (api: FakeKmsApi, keyId: string, region?: string): AwsKmsKeyProvider =>
    new AwsKmsKeyProvider(
      stubConfig({ ENCRYPTION_KMS_KEY_ID: keyId, ENCRYPTION_KMS_REGION: region }),
      {
        requestHandler: api.requestHandler,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      },
    );

  it("sends the encryption context to KMS on both calls", async () => {
    // Not a detail: the context is only a control if it reaches the service. A
    // provider that built it and never serialised it would pass every round-trip
    // assertion in the contract.
    const api = new FakeKmsApi();
    const provider = providerFor(api, api.createKey());

    const key = await provider.generateDataKey({ table: "orders", column: "itemsCiphertext" });
    await provider.unwrapDataKey(key.wrapped, { table: "orders", column: "itemsCiphertext" });

    expect(api.calls).toEqual([
      expect.objectContaining({
        operation: "GenerateDataKey",
        context: { table: "orders", column: "itemsCiphertext" },
      }),
      expect.objectContaining({
        operation: "Decrypt",
        context: { table: "orders", column: "itemsCiphertext" },
      }),
    ]);
  });

  it("names the key on Decrypt, so a blob from another key is refused", async () => {
    // The attack: whoever can write the column replaces the wrapped key with one
    // they minted under a key this role may also decrypt under, then supplies a
    // ciphertext that authenticates under *their* data key. KMS will use the key
    // the blob names unless the call names one — so the `KeyId` on the Decrypt
    // is what closes it, and this is the spec that fails if it is ever removed.
    const api = new FakeKmsApi();
    const ours = api.createKey();
    const theirs = api.createKey();
    const context = { table: "orders", column: "itemsCiphertext" };

    const attackersKey = await providerFor(api, theirs).generateDataKey(context);

    await expect(
      providerFor(api, ours).unwrapDataKey(attackersKey.wrapped, context),
    ).rejects.toThrow(DataKeyUnwrapError);
    expect(api.calls.at(-1)).toEqual(expect.objectContaining({ keyId: ours }));
  });

  it("works through an alias, which is how a key is rotated without a deploy", async () => {
    const api = new FakeKmsApi();
    const alias = api.alias("alias/orders-field-key", api.createKey());
    const provider = providerFor(api, alias, "eu-west-2");

    const key = await provider.generateDataKey({ table: "orders", column: "itemsCiphertext" });

    expect(
      await provider.unwrapDataKey(key.wrapped, { table: "orders", column: "itemsCiphertext" }),
    ).toEqual(key.plaintext);
  });

  it("reports a key whose material was replaced as an unwrap failure, not a service error", async () => {
    // The restored-from-backup case: the key id still resolves, and the blob was
    // wrapped under material that is gone. It must arrive as "these bytes are not
    // ours" so the materials cache does not retry it forever.
    const api = new FakeKmsApi();
    const keyId = api.createKey();
    const provider = providerFor(api, keyId);
    const context = { table: "orders", column: "itemsCiphertext" };
    const key = await provider.generateDataKey(context);

    api.replaceMaterial(keyId);

    await expect(provider.unwrapDataKey(key.wrapped, context)).rejects.toThrow(DataKeyUnwrapError);
  });

  it("reports a key that does not exist as an operator problem", async () => {
    const api = new FakeKmsApi();
    api.createKey();
    const provider = providerFor(api, "arn:aws:kms:eu-west-2:111122223333:key/absent");

    const failure = await provider
      .generateDataKey({ table: "orders", column: "itemsCiphertext" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KeyProviderError);
    expect(failure).not.toBeInstanceOf(DataKeyUnwrapError);
    expect((failure as Error).message).toContain("ENCRYPTION_KMS_KEY_ID");
  });

  it("refuses to work with no key id rather than defaulting to one", () => {
    const api = new FakeKmsApi();
    const provider = providerFor(api, "");

    expect(provider.isConfigured).toBe(false);
    return expect(
      provider.generateDataKey({ table: "orders", column: "itemsCiphertext" }),
    ).rejects.toThrow(KeyProviderError);
  });
});

describe("LocalMasterKeyProvider", () => {
  const providerFor = (masterKey: string | undefined): LocalMasterKeyProvider =>
    new LocalMasterKeyProvider(stubConfig({ ENCRYPTION_LOCAL_MASTER_KEY: masterKey }));

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["too short", randomBytes(16).toString("base64")],
    ["too long", randomBytes(64).toString("base64")],
    // Base64 decoding ignores characters outside its alphabet, so this decodes
    // to *something*. Accepting it would mean encrypting under a key nobody
    // meant, which reads back as corruption rather than as a typo.
    ["not base64", "this is definitely not a base64 encoded 32 byte key!!"],
    // What an unexpanded placeholder or a truncated secret produces.
    ["all zeroes", Buffer.alloc(32).toString("base64")],
  ])("reports itself unconfigured when the master key is %s", (_case, masterKey) => {
    expect(providerFor(masterKey).isConfigured).toBe(false);
  });

  it("refuses work rather than inventing a key", async () => {
    const provider = providerFor(undefined);

    await expect(provider.generateDataKey({ table: "orders", column: "c" })).rejects.toThrow(
      KeyProviderError,
    );
    await expect(
      provider.unwrapDataKey(Buffer.alloc(61), { table: "orders", column: "c" }),
    ).rejects.toThrow(KeyProviderError);
  });

  it("cannot read a key wrapped under another master key", async () => {
    // The property that makes rotating this secret a real migration rather than
    // an edit: rows written under the old key stop being readable.
    const context = { table: "orders", column: "itemsCiphertext" };
    const before = providerFor(randomBytes(32).toString("base64"));
    const after = providerFor(randomBytes(32).toString("base64"));
    const key = await before.generateDataKey(context);

    await expect(after.unwrapDataKey(key.wrapped, context)).rejects.toThrow(DataKeyUnwrapError);
  });

  it("accepts a master key with or without base64 padding", async () => {
    const raw = randomBytes(32);
    const padded = raw.toString("base64");

    expect(providerFor(padded).isConfigured).toBe(true);
    expect(providerFor(padded.replace(/=+$/, "")).isConfigured).toBe(true);

    // And the two are the same key, not two that merely both load.
    const context = { table: "orders", column: "itemsCiphertext" };
    const key = await providerFor(padded).generateDataKey(context);
    expect(
      await providerFor(padded.replace(/=+$/, "")).unwrapDataKey(key.wrapped, context),
    ).toEqual(key.plaintext);
  });
});
