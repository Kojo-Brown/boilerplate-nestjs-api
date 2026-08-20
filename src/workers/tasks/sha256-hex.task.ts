import { createHash } from "node:crypto";

/**
 * Hashes a payload with SHA-256 and returns the digest as lowercase hex.
 *
 * The reason this is a worker task rather than a call to `crypto` on the
 * event-loop thread: `createHash().update(large).digest()` is synchronous
 * (Node exposes no async variant for a whole-buffer digest), and hashing a
 * 100 MB payload on the event loop stalls every other request that landed on
 * the same process for the ~200 ms it takes. Moving it to a worker lets the
 * request that triggered it wait for the digest without every other request
 * having to.
 */
export interface Sha256HexInput {
  /**
   * The bytes to hash. Transferred, not copied — the caller loses ownership,
   * which is fine because a buffer big enough to matter here is big enough
   * to want moved.
   */
  readonly bytes: Uint8Array;
}

export interface Sha256HexOutput {
  /** Lowercase hex, 64 characters. */
  readonly hex: string;
  /** The length of the input, echoed back so a caller can log both halves. */
  readonly byteLength: number;
}

export function sha256Hex(input: Sha256HexInput): Sha256HexOutput {
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  return { hex: digest, byteLength: input.bytes.byteLength };
}

export interface Sha256HexTask {
  input: Sha256HexInput;
  output: Sha256HexOutput;
}

declare module "../ports/worker-pool.port" {
  interface WorkerTaskMap {
    readonly "sha256.hex": Sha256HexTask;
  }
}
