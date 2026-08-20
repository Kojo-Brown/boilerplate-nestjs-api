import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256-hex.task";

describe("sha256Hex", () => {
  it("returns the SHA-256 of an empty payload", () => {
    const out = sha256Hex({ bytes: new Uint8Array() });
    expect(out.hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(out.byteLength).toBe(0);
  });

  it("returns the same digest as node:crypto", () => {
    const bytes = new TextEncoder().encode("hello, worker");
    const reference = createHash("sha256").update(bytes).digest("hex");
    expect(sha256Hex({ bytes }).hex).toBe(reference);
  });

  it("echoes the byte length", () => {
    const bytes = new Uint8Array(256).fill(1);
    const out = sha256Hex({ bytes });
    expect(out.byteLength).toBe(256);
    expect(out.hex).toHaveLength(64);
  });
});
