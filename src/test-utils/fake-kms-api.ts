import { Readable } from "node:stream";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * An in-process AWS KMS, spoken over HTTP.
 *
 * Installed as the SDK's `requestHandler`, so a command sent through
 * `AwsKmsKeyProvider` is really signed, serialised into KMS's `awsJson1_1`
 * protocol and answered with a body the SDK's own parser and error
 * deserialiser have to make sense of. Stubbing `KMSClient.send` would have been
 * a fifth of the code and would have tested the provider against our idea of
 * the SDK — a blob we forgot to base64-encode, an `EncryptionContext` that never
 * reached the request body, a `KeyId` left off the `Decrypt`: a stub is handed
 * the parsed command and sees none of it. This is the same bargain
 * `FakeS3Api` makes for the storage adapter.
 *
 * The cryptography is real, and has to be, because the properties the contract
 * asserts are properties of KMS rather than of our code: that a wrapped key is
 * refused under a different encryption context, that a blob from another CMK is
 * refused when the call names one, and that `Decrypt` *without* a `KeyId`
 * happily uses whichever key the blob names — which is the behaviour the
 * provider pins `KeyId` to defend against.
 *
 * It implements the two operations the provider uses and nothing else. An
 * unrecognised target is a 400 naming it, rather than a silent 200, so a third
 * call added to the provider fails the contract instead of quietly passing.
 */
export class FakeKmsApi {
  /** keyId → the master key that wraps under it. */
  private readonly keys = new Map<string, Buffer>();
  /** alias → keyId, so an `alias/…` configuration is exercised too. */
  private readonly aliases = new Map<string, string>();

  /** Every call answered, for assertions about what reached the wire. */
  readonly calls: FakeKmsCall[] = [];

  /** Adds a customer master key. Returns the id, for a provider to be pointed at. */
  createKey(
    keyId = `arn:aws:kms:eu-west-2:111122223333:key/${randomBytes(8).toString("hex")}`,
  ): string {
    this.keys.set(keyId, randomBytes(32));
    return keyId;
  }

  /** Points an alias at a key, the way an operator does for rotation. */
  alias(name: string, keyId: string): string {
    this.aliases.set(name, keyId);
    return name;
  }

  /**
   * Replaces a key's material without changing its id.
   *
   * KMS cannot do this — rotation mints new material and keeps the old for
   * decrypting — and that is exactly why it is here: it is the only way to
   * produce the state a restored-from-backup row is in, where the blob names a
   * key that exists and holds material it was not wrapped under.
   */
  replaceMaterial(keyId: string): void {
    this.keys.set(keyId, randomBytes(32));
  }

  /**
   * The SDK's `requestHandler` shape.
   *
   * Typed structurally rather than against `@smithy/protocol-http`, which this
   * package does not declare — the same reason `FakeS3Api` does.
   */
  get requestHandler(): FakeRequestHandler {
    return {
      handle: (request: FakeHttpRequest) => Promise.resolve({ response: this.answer(request) }),
      updateHttpClientConfig: () => undefined,
      httpHandlerConfigs: () => ({}),
    };
  }

  private answer(request: FakeHttpRequest): FakeHttpResponse {
    const target = (header(request, "x-amz-target") ?? "").split(".").pop() ?? "";
    const body = JSON.parse(bodyText(request)) as Record<string, unknown>;

    switch (target) {
      case "GenerateDataKey":
        return this.generateDataKey(body);
      case "Decrypt":
        return this.decrypt(body);
      default:
        return errorResponse(
          400,
          "UnsupportedOperationException",
          `FakeKmsApi does not implement ${JSON.stringify(target)}`,
        );
    }
  }

  private generateDataKey(body: Record<string, unknown>): FakeHttpResponse {
    const requested = String(body["KeyId"] ?? "");
    const context = (body["EncryptionContext"] ?? {}) as Record<string, string>;
    this.calls.push({ operation: "GenerateDataKey", keyId: requested, context });

    const keyId = this.resolve(requested);
    const master = keyId === null ? undefined : this.keys.get(keyId);
    if (keyId === null || master === undefined) {
      return errorResponse(400, "NotFoundException", `Key ${requested} does not exist`);
    }
    if (body["KeySpec"] !== "AES_256") {
      return errorResponse(
        400,
        "ValidationException",
        `FakeKmsApi only mints AES_256 keys, not ${JSON.stringify(body["KeySpec"])}`,
      );
    }

    const plaintext = randomBytes(32);
    return jsonResponse({
      KeyId: keyId,
      Plaintext: plaintext.toString("base64"),
      CiphertextBlob: wrap(keyId, master, plaintext, context).toString("base64"),
    });
  }

  private decrypt(body: Record<string, unknown>): FakeHttpResponse {
    const named = body["KeyId"] === undefined ? null : String(body["KeyId"]);
    const context = (body["EncryptionContext"] ?? {}) as Record<string, string>;
    this.calls.push({ operation: "Decrypt", keyId: named, context });

    const blob = Buffer.from(String(body["CiphertextBlob"] ?? ""), "base64");
    const parsed = parseBlob(blob);
    if (parsed === null) {
      return errorResponse(
        400,
        "InvalidCiphertextException",
        "The ciphertext refers to a customer master key that does not exist",
      );
    }

    // The real behaviour, and the one worth reproducing exactly: with no `KeyId`
    // on the call, KMS uses whichever key the blob names. An attacker who can
    // write a column and who holds *any* key this role may decrypt under needs
    // nothing else. Naming a key turns that into a refusal.
    if (named !== null) {
      const pinned = this.resolve(named);
      if (pinned === null) {
        return errorResponse(400, "NotFoundException", `Key ${named} does not exist`);
      }
      if (pinned !== parsed.keyId) {
        return errorResponse(
          400,
          "IncorrectKeyException",
          "The key ID in the request does not identify a CMK that can perform this operation",
        );
      }
    }

    const master = this.keys.get(parsed.keyId);
    if (master === undefined) {
      return errorResponse(400, "NotFoundException", `Key ${parsed.keyId} does not exist`);
    }

    const plaintext = unwrap(master, parsed, context);
    if (plaintext === null) {
      // KMS reports a corrupt blob and a mismatched encryption context
      // identically, which is why `DataKeyUnwrapError` is one error.
      return errorResponse(
        400,
        "InvalidCiphertextException",
        "The ciphertext or additional authenticated data is invalid",
      );
    }

    return jsonResponse({
      KeyId: parsed.keyId,
      Plaintext: plaintext.toString("base64"),
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    });
  }

  private resolve(idOrAlias: string): string | null {
    const target = idOrAlias.startsWith("alias/") ? this.aliases.get(idOrAlias) : idOrAlias;
    if (target === undefined) return null;
    return this.keys.has(target) ? target : null;
  }
}

export interface FakeKmsCall {
  readonly operation: "GenerateDataKey" | "Decrypt";
  /** What the caller named. `null` on a `Decrypt` that named nothing. */
  readonly keyId: string | null;
  readonly context: Record<string, string>;
}

interface ParsedBlob {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/** `keyIdLength | keyId | iv | tag | ciphertext`, so a blob names its own key. */
function wrap(
  keyId: string,
  master: Buffer,
  plaintext: Buffer,
  context: Record<string, string>,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv, { authTagLength: 16 });
  cipher.setAAD(contextBytes(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const id = Buffer.from(keyId, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length, 0);
  return Buffer.concat([length, id, iv, cipher.getAuthTag(), ciphertext]);
}

function parseBlob(blob: Buffer): ParsedBlob | null {
  if (blob.length < 2) return null;
  const idLength = blob.readUInt16BE(0);
  if (blob.length < 2 + idLength + 12 + 16) return null;

  return {
    keyId: blob.subarray(2, 2 + idLength).toString("utf8"),
    iv: blob.subarray(2 + idLength, 2 + idLength + 12),
    tag: blob.subarray(2 + idLength + 12, 2 + idLength + 28),
    ciphertext: blob.subarray(2 + idLength + 28),
  };
}

function unwrap(
  master: Buffer,
  parsed: ParsedBlob,
  context: Record<string, string>,
): Buffer | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", master, parsed.iv, { authTagLength: 16 });
    decipher.setAAD(contextBytes(context));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/** The encryption context, canonically, so KMS's authentication of it is real here. */
function contextBytes(context: Record<string, string>): Buffer {
  const entries = Object.keys(context)
    .sort()
    .map((key) => `${key}=${context[key] as string}`)
    .join("&");
  return Buffer.from(entries, "utf8");
}

function jsonResponse(payload: Record<string, unknown>): FakeHttpResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "application/x-amz-json-1.1" },
    body: Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]),
  };
}

/**
 * An `awsJson1_1` error.
 *
 * Both the `__type` member and the `x-amzn-errortype` header are set, because
 * the SDK's error deserialiser will take either and which one it prefers is its
 * business, not this fake's. Getting it wrong would surface as a generic
 * `KMSServiceException` and the provider's error mapping — the part most worth
 * testing — would never be reached.
 */
function errorResponse(statusCode: number, type: string, message: string): FakeHttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amzn-errortype": `${type}:`,
    },
    body: Readable.from([Buffer.from(JSON.stringify({ __type: type, message }), "utf8")]),
  };
}

function header(request: FakeHttpRequest, name: string): string | undefined {
  const match = Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

/**
 * The request body as text, without going through `valueOf`.
 *
 * The SDK hands the handler a `Uint8Array` subclass that warns — and says it will
 * one day throw — when a string method is called on it, and `Buffer.from(body)`
 * reaches for `valueOf` and trips it. Reading the bytes through the view's own
 * offset and length does not.
 */
function bodyText(request: FakeHttpRequest): string {
  const body = request.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  return "{}";
}

interface FakeHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

interface FakeHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Readable;
}

interface FakeRequestHandler {
  handle(request: FakeHttpRequest): Promise<{ response: FakeHttpResponse }>;
  updateHttpClientConfig(): void;
  httpHandlerConfigs(): Record<string, never>;
}
