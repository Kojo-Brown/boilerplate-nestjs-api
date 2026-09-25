import { EncryptionNotConfiguredError } from "./crypto.errors";
import { selectKeyProvider } from "./key-provider.factory";
import type { KeyProvider } from "./ports";

function provider(name: "local" | "kms", isConfigured: boolean): KeyProvider {
  return {
    name,
    isConfigured,
    requiredEnv: [name === "kms" ? "ENCRYPTION_KMS_KEY_ID" : "ENCRYPTION_LOCAL_MASTER_KEY"],
    generateDataKey: () => Promise.reject(new Error("not called")),
    unwrapDataKey: () => Promise.reject(new Error("not called")),
  };
}

const silent = { log: () => undefined, warn: () => undefined };

describe("selectKeyProvider", () => {
  it("returns the provider the environment named", () => {
    const kms = provider("kms", true);

    expect(selectKeyProvider("kms", [provider("local", true), kms], "test", silent)).toBe(kms);
  });

  it("refuses a selected provider that has nothing to work with", () => {
    // At boot, so the failure is a startup error naming the missing variable
    // rather than a 500 on the first checkout — which would look like a payments
    // problem.
    expect(() => selectKeyProvider("kms", [provider("kms", false)], "test", silent)).toThrow(
      EncryptionNotConfiguredError,
    );
    expect(() => selectKeyProvider("kms", [provider("kms", false)], "test", silent)).toThrow(
      /ENCRYPTION_KMS_KEY_ID/,
    );
  });

  it("does not fall back to another provider", () => {
    // Falling back would be the worst of both: it boots, it encrypts, and it
    // encrypts under a key nobody chose.
    expect(() =>
      selectKeyProvider("kms", [provider("local", true), provider("kms", false)], "test", silent),
    ).toThrow(EncryptionNotConfiguredError);
  });

  it("says so when no provider by that name is registered", () => {
    expect(() => selectKeyProvider("kms", [provider("local", true)], "test", silent)).toThrow(
      /crypto.module.ts/,
    );
  });

  it("logs which provider is in use, because that is the first question asked", () => {
    const logged: string[] = [];
    const warned: string[] = [];

    selectKeyProvider("local", [provider("local", true)], "development", {
      log: (message: unknown) => logged.push(String(message)),
      warn: (message: unknown) => warned.push(String(message)),
    });

    expect(logged).toEqual(['Field encryption is using the "local" key provider']);
    expect(warned).toEqual([]);
  });

  it("warns, rather than refusing, about the local provider in production", () => {
    // A refusal would leave a deployment that is not on AWS with a plaintext
    // column instead of a better key, which is worse in the only direction that
    // matters. So it boots, and the warning says what is not bought — because
    // the failure mode is somebody believing they have a control they do not.
    const warned: string[] = [];

    const chosen = selectKeyProvider("local", [provider("local", true)], "production", {
      log: () => undefined,
      warn: (message: unknown) => warned.push(String(message)),
    });

    expect(chosen.name).toBe("local");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("ENCRYPTION_KEY_PROVIDER=kms");
    expect(warned[0]).toContain("no per-use audit trail");
  });

  it("does not warn about KMS in production", () => {
    const warned: string[] = [];

    selectKeyProvider("kms", [provider("kms", true)], "production", {
      log: () => undefined,
      warn: (message: unknown) => warned.push(String(message)),
    });

    expect(warned).toEqual([]);
  });
});
