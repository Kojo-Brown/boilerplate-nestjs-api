import { randomBytes } from "crypto";
import { EnvelopeFormatError } from "./crypto.errors";
import {
  ENVELOPE_FORMAT_VERSION,
  IV_BYTES,
  openField,
  parseEnvelope,
  sealField,
  serialiseEnvelope,
  TAG_BYTES,
} from "./field-envelope";
import type { DataKey } from "./ports";

const AAD = Buffer.from("orders.itemsCiphertext|order-1", "utf8");
const OTHER_AAD = Buffer.from("orders.itemsCiphertext|order-2", "utf8");

function dataKey(): DataKey {
  return { plaintext: randomBytes(32), wrapped: randomBytes(184) };
}

describe("sealField / openField", () => {
  it("round-trips a value under the same key and aad", () => {
    const key = dataKey();
    const plaintext = Buffer.from(JSON.stringify([{ sku: "SKU-DESK-01", quantity: 2 }]), "utf8");

    const stored = sealField(key, plaintext, AAD);

    expect(openField(key.plaintext, parseEnvelope(stored), AAD).equals(plaintext)).toBe(true);
  });

  it("stores no plaintext", () => {
    const key = dataKey();
    const stored = sealField(key, Buffer.from("SKU-DESK-01", "utf8"), AAD);

    expect(stored.includes("SKU-DESK-01")).toBe(false);
    expect(stored.includes(key.plaintext)).toBe(false);
  });

  it("produces different bytes for the same value, because the IV is fresh", () => {
    const key = dataKey();
    const plaintext = Buffer.from("same value", "utf8");

    expect(sealField(key, plaintext, AAD).equals(sealField(key, plaintext, AAD))).toBe(false);
  });

  it("refuses to open under a different aad", () => {
    // The control that stops a ciphertext being copied onto another row and
    // decrypted there by the application itself.
    const key = dataKey();
    const stored = sealField(key, Buffer.from("secret", "utf8"), AAD);

    expect(() => openField(key.plaintext, parseEnvelope(stored), OTHER_AAD)).toThrow();
  });

  it("refuses to open under a different key", () => {
    const stored = sealField(dataKey(), Buffer.from("secret", "utf8"), AAD);

    expect(() => openField(randomBytes(32), parseEnvelope(stored), AAD)).toThrow();
  });

  it("refuses a ciphertext with a byte flipped", () => {
    // GCM authenticates, which is the reason for choosing it: an attacker who can
    // write this column cannot edit a stored value into another one.
    const key = dataKey();
    const stored = sealField(key, Buffer.from("100.00", "utf8"), AAD);
    const tampered = Buffer.from(stored);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0x01, tampered.length - 1);

    expect(() => openField(key.plaintext, parseEnvelope(tampered), AAD)).toThrow();
  });

  it("refuses a swapped authentication tag", () => {
    const key = dataKey();
    const first = parseEnvelope(sealField(key, Buffer.from("one", "utf8"), AAD));
    const second = parseEnvelope(sealField(key, Buffer.from("two", "utf8"), AAD));

    expect(() => openField(key.plaintext, { ...first, tag: second.tag }, AAD)).toThrow();
  });

  it("round-trips an empty value", () => {
    const key = dataKey();
    const stored = sealField(key, Buffer.alloc(0), AAD);

    expect(openField(key.plaintext, parseEnvelope(stored), AAD)).toHaveLength(0);
  });

  it("refuses a data key that is not 32 bytes", () => {
    expect(() =>
      sealField({ plaintext: randomBytes(16), wrapped: randomBytes(10) }, Buffer.alloc(0), AAD),
    ).toThrow(EnvelopeFormatError);
  });
});

describe("parseEnvelope", () => {
  it("recovers exactly what was serialised", () => {
    const envelope = {
      wrappedKey: randomBytes(184),
      iv: randomBytes(IV_BYTES),
      tag: randomBytes(TAG_BYTES),
      ciphertext: randomBytes(40),
    };

    const parsed = parseEnvelope(serialiseEnvelope(envelope));

    expect(parsed.wrappedKey.equals(envelope.wrappedKey)).toBe(true);
    expect(parsed.iv.equals(envelope.iv)).toBe(true);
    expect(parsed.tag.equals(envelope.tag)).toBe(true);
    expect(parsed.ciphertext.equals(envelope.ciphertext)).toBe(true);
  });

  it("refuses a value shorter than the header", () => {
    expect(() => parseEnvelope(Buffer.alloc(10))).toThrow(EnvelopeFormatError);
  });

  it("refuses an unknown format version by name", () => {
    const stored = sealField(dataKey(), Buffer.from("x", "utf8"), AAD);
    stored.writeUInt8(ENVELOPE_FORMAT_VERSION + 1, 0);

    expect(() => parseEnvelope(stored)).toThrow(/format version 2 is not 1/);
  });

  it("refuses a wrapped-key length that overruns the value", () => {
    // `Buffer.subarray` clamps rather than throwing, so without this check a
    // truncated column would reach the cipher as a short IV and fail there,
    // several frames away, with a message about AES.
    const stored = sealField(dataKey(), Buffer.from("x", "utf8"), AAD);
    stored.writeUInt16BE(0xffff, 1);

    expect(() => parseEnvelope(stored)).toThrow(/overruns/);
  });

  it("refuses a value that claims no wrapped key", () => {
    const stored = sealField(dataKey(), Buffer.from("x", "utf8"), AAD);
    stored.writeUInt16BE(0, 1);

    expect(() => parseEnvelope(stored)).toThrow(/empty/);
  });

  it("refuses to serialise a wrapped key too large for the length field", () => {
    expect(() =>
      serialiseEnvelope({
        wrappedKey: Buffer.alloc(0x10000),
        iv: randomBytes(IV_BYTES),
        tag: randomBytes(TAG_BYTES),
        ciphertext: Buffer.alloc(0),
      }),
    ).toThrow(EnvelopeFormatError);
  });
});
