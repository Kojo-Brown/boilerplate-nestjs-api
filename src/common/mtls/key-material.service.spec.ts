import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCertificateAuthority } from "@/test-utils/test-certificates";
import type { TestCertificateAuthority } from "@/test-utils/test-certificates";
import { KeyMaterialError } from "./key-material";
import { MtlsKeyMaterialService, nodeReloadScheduler } from "./key-material.service";
import type { CancellableInterval, MtlsLogger, ReloadScheduler } from "./key-material.service";

/** The mounted secret: three fixed paths whose contents a rotation replaces. */
class MountedMaterial {
  readonly directory = mkdtempSync(join(tmpdir(), "mtls-mount-"));
  readonly certFile = join(this.directory, "tls.crt");
  readonly keyFile = join(this.directory, "tls.key");
  readonly caFile = join(this.directory, "ca.crt");

  write(ca: TestCertificateAuthority, identity: string): void {
    const issued = ca.issue({ commonName: "orders", subjectAltNames: [`URI:${identity}`] });
    writeFileSync(this.certFile, issued.certPem);
    writeFileSync(this.keyFile, issued.keyPem);
    writeFileSync(this.caFile, ca.certPem);
  }

  get files() {
    return { certFile: this.certFile, keyFile: this.keyFile, caFile: this.caFile };
  }
}

function recordingLogger(): MtlsLogger & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const record = (level: string) => (message: unknown) =>
    void lines.push({ level, message: String(message) });
  return { lines, log: record("log"), warn: record("warn"), error: record("error") };
}

/** A scheduler that hands the callback back instead of running it on a timer. */
function manualScheduler(): ReloadScheduler & { fire(): void; cancelled: boolean; ms: number } {
  const state = {
    callback: null as (() => void) | null,
    cancelled: false,
    ms: 0,
    fire(): void {
      state.callback?.();
    },
    every(ms: number, callback: () => void): CancellableInterval {
      state.ms = ms;
      state.callback = callback;
      return {
        cancel: () => {
          state.cancelled = true;
        },
      };
    },
  };
  return state;
}

const IDENTITY = "spiffe://cluster.local/ns/prod/sa/orders";
const NOW = new Date(Date.now() + 60_000);

describe("MtlsKeyMaterialService", () => {
  let mount: MountedMaterial;
  let ca: TestCertificateAuthority;

  beforeEach(() => {
    mount = new MountedMaterial();
    ca = createTestCertificateAuthority();
    mount.write(ca, IDENTITY);
  });

  function service(overrides: Partial<Parameters<typeof build>[0]> = {}) {
    return build({
      files: mount.files,
      reloadIntervalMs: 60_000,
      expiryWarningDays: 0,
      now: () => NOW,
      ...overrides,
    });
  }

  function build(options: {
    files: { certFile: string; keyFile: string; caFile: string };
    reloadIntervalMs: number;
    expiryWarningDays: number;
    now: () => Date;
    scheduler?: ReloadScheduler;
    logger?: MtlsLogger;
  }) {
    return new MtlsKeyMaterialService(options);
  }

  it("loads on start and reports the identity the certificate carries", () => {
    const logger = recordingLogger();
    const subject = service({ logger, scheduler: manualScheduler() });

    const material = subject.start();

    expect(material.identities).toEqual([IDENTITY]);
    expect(subject.current()).toBe(material);
    expect(logger.lines[0]?.message).toContain("mTLS material loaded");
    subject.stop();
  });

  it("refuses to start on material it cannot load, rather than starting without one", () => {
    writeFileSync(mount.certFile, "");
    const subject = service({ logger: recordingLogger(), scheduler: manualScheduler() });

    expect(() => subject.start()).toThrow(KeyMaterialError);
    expect(subject.peek()).toBeNull();
  });

  it("throws rather than answering with material it does not have", () => {
    expect(() => service().current()).toThrow(/before it was loaded/);
  });

  it("schedules the reload at the configured interval and fires it", () => {
    const scheduler = manualScheduler();
    const subject = service({ scheduler, logger: recordingLogger(), reloadIntervalMs: 30_000 });
    subject.start();

    expect(scheduler.ms).toBe(30_000);

    const rotations: string[][] = [];
    subject.onRotate((material) => void rotations.push([...material.identities]));
    mount.write(ca, "spiffe://cluster.local/ns/prod/sa/orders-v2");
    scheduler.fire();

    expect(rotations).toEqual([["spiffe://cluster.local/ns/prod/sa/orders-v2"]]);
    subject.stop();
  });

  it("schedules nothing when reloading is disabled", () => {
    const scheduler = manualScheduler();
    const subject = service({ scheduler, logger: recordingLogger(), reloadIntervalMs: 0 });

    subject.start();

    expect(scheduler.ms).toBe(0);
    scheduler.fire();
    expect(scheduler.cancelled).toBe(false);
    subject.stop();
  });

  it("calls a reload that found the same files unchanged, and tells nobody", () => {
    const subject = service({ logger: recordingLogger(), scheduler: manualScheduler() });
    subject.start();
    const listener = jest.fn();
    subject.onRotate(listener);

    expect(subject.reload()).toBe("unchanged");
    expect(listener).not.toHaveBeenCalled();
    subject.stop();
  });

  it("swaps the material in and notifies when the files changed", () => {
    const subject = service({ logger: recordingLogger(), scheduler: manualScheduler() });
    const before = subject.start();
    const listener = jest.fn();
    subject.onRotate(listener);

    mount.write(ca, "spiffe://cluster.local/ns/prod/sa/orders-v2");

    expect(subject.reload()).toBe("rotated");
    expect(subject.current().fingerprint).not.toBe(before.fingerprint);
    expect(listener).toHaveBeenCalledWith(subject.current());
    subject.stop();
  });

  it("notices a trust bundle that gained an anchor even though the leaf is untouched", () => {
    const subject = service({ logger: recordingLogger(), scheduler: manualScheduler() });
    subject.start();
    const nextCa = createTestCertificateAuthority("Next Root CA");

    // The first step of a CA rotation: trust the new anchor while everything is
    // still presenting certificates from the old one.
    writeFileSync(mount.caFile, `${ca.certPem}${nextCa.certPem}`);

    expect(subject.reload()).toBe("rotated");
    expect(subject.current().ca).toHaveLength(2);
    subject.stop();
  });

  /**
   * The window every rotation has and no rotation mentions: the certificate has
   * been written and the key has not. Loading that pair produces something
   * OpenSSL will not build a context from — and swapping it in would turn a
   * rotation into an outage, since what we are holding still works.
   */
  it("keeps the material it has when a reload finds a half-written rotation", () => {
    const logger = recordingLogger();
    const subject = service({ logger, scheduler: manualScheduler() });
    const before = subject.start();
    const listener = jest.fn();
    subject.onRotate(listener);

    const replacement = ca.issue({ commonName: "orders", subjectAltNames: [`URI:${IDENTITY}`] });
    writeFileSync(mount.certFile, replacement.certPem);

    expect(subject.reload()).toBe("failed");
    expect(subject.current()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(logger.lines.some((line) => line.level === "error")).toBe(true);

    // And the rotation completes on the next tick, once the key lands.
    writeFileSync(mount.keyFile, replacement.keyPem);
    expect(subject.reload()).toBe("rotated");
    subject.stop();
  });

  it("keeps notifying the other listeners when one of them throws", () => {
    const logger = recordingLogger();
    const subject = service({ logger, scheduler: manualScheduler() });
    subject.start();
    const second = jest.fn();
    subject.onRotate(() => {
      throw new Error("the server refused its new context");
    });
    subject.onRotate(second);

    mount.write(ca, "spiffe://cluster.local/ns/prod/sa/orders-v2");
    subject.reload();

    expect(second).toHaveBeenCalledTimes(1);
    expect(logger.lines.some((line) => line.message.includes("rotation listener threw"))).toBe(
      true,
    );
    subject.stop();
  });

  it("stops notifying a listener that unsubscribed", () => {
    const subject = service({ logger: recordingLogger(), scheduler: manualScheduler() });
    subject.start();
    const listener = jest.fn();
    subject.onRotate(listener)();

    mount.write(ca, "spiffe://cluster.local/ns/prod/sa/orders-v2");
    subject.reload();

    expect(listener).not.toHaveBeenCalled();
    subject.stop();
  });

  it("warns while the material is inside the expiry window, and not before", () => {
    const quiet = recordingLogger();
    const quietService = service({
      logger: quiet,
      scheduler: manualScheduler(),
      expiryWarningDays: 1,
    });
    quietService.start();
    expect(quiet.lines.filter((line) => line.level === "warn")).toHaveLength(0);
    quietService.stop();

    const loud = recordingLogger();
    const loudService = service({
      logger: loud,
      scheduler: manualScheduler(),
      expiryWarningDays: 30,
    });
    loudService.start();

    expect(
      loud.lines.some((line) => line.level === "warn" && /expires in/.test(line.message)),
    ).toBe(true);
    loudService.stop();
  });

  it("cancels the timer and forgets its listeners on stop", () => {
    const scheduler = manualScheduler();
    const subject = service({ scheduler, logger: recordingLogger() });
    subject.start();
    const listener = jest.fn();
    subject.onRotate(listener);

    subject.stop();
    subject.stop();

    expect(scheduler.cancelled).toBe(true);
    mount.write(ca, "spiffe://cluster.local/ns/prod/sa/orders-v2");
    subject.reload();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("nodeReloadScheduler", () => {
  it("returns a timer that can be cancelled and does not hold the process open", () => {
    const fired = jest.fn();
    const handle = nodeReloadScheduler.every(3_600_000, fired);

    expect(typeof handle.cancel).toBe("function");
    handle.cancel();
    expect(fired).not.toHaveBeenCalled();
  });
});
