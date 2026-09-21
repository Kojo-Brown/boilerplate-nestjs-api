import { Logger } from "@nestjs/common";
import type { Server as TlsServer } from "node:tls";
import type { Agent } from "undici";
import { MtlsKeyMaterialService } from "./key-material.service";
import type { ReloadScheduler } from "./key-material.service";
import { MtlsDispatcherRegistry } from "./mtls-dispatcher";
import { attachSecureContextRotation, buildMtlsServerOptions } from "./mtls-server";
import type { MtlsServerOptions } from "./mtls-server";
import { mtlsEnvFromProcess, parsePeerMap } from "./mtls.env";
import type { MtlsEnv } from "./mtls.env";

/**
 * The process-wide mTLS handle, owned by `main.ts`.
 *
 * It exists for the same reason `telemetry/register.ts` exports one: the TLS
 * options are an argument to `NestFactory.create`, so they have to be built
 * before the application — and therefore before the injector — exists. A
 * provider would be too late by exactly one step.
 *
 * Everything it holds is an ordinary class that can be constructed directly,
 * and every one of those is tested that way. What this adds is the wiring: one
 * key-material service, one dispatcher registry built from it, and a `stop()`
 * that ends both.
 */
export class MtlsRuntime {
  private readonly logger = new Logger(MtlsRuntime.name);
  private keyMaterial: MtlsKeyMaterialService | null = null;
  private dispatchers: MtlsDispatcherRegistry | null = null;
  private detachServer: (() => void) | null = null;

  /**
   * Loads the material and returns the listener's TLS options, or `undefined`
   * when mTLS is off.
   *
   * Throws if the material cannot be loaded. A service configured for mTLS that
   * cannot present a certificate has nothing to serve, and the deployment
   * should find that out here rather than one failed handshake at a time.
   */
  start(env: MtlsEnv, scheduler?: ReloadScheduler): MtlsServerOptions | undefined {
    if (!env.MTLS_ENABLED) return undefined;

    const files = {
      certFile: required(env.MTLS_CERT_FILE, "MTLS_CERT_FILE"),
      keyFile: required(env.MTLS_KEY_FILE, "MTLS_KEY_FILE"),
      caFile: required(env.MTLS_CA_FILE, "MTLS_CA_FILE"),
    };

    const keyMaterial = new MtlsKeyMaterialService({
      files,
      ...(env.MTLS_KEY_PASSPHRASE === undefined ? {} : { passphrase: env.MTLS_KEY_PASSPHRASE }),
      reloadIntervalMs: env.MTLS_RELOAD_INTERVAL_MS,
      expiryWarningDays: env.MTLS_EXPIRY_WARNING_DAYS,
      now: () => new Date(),
      ...(scheduler === undefined ? {} : { scheduler }),
    });

    const material = keyMaterial.start();
    this.keyMaterial = keyMaterial;

    const peers = parsePeerMap(env.MTLS_PEERS);
    if (peers.size > 0) {
      const dispatchers = new MtlsDispatcherRegistry(peers, keyMaterial);
      dispatchers.start();
      this.dispatchers = dispatchers;
      this.logger.log(
        `Outbound mTLS configured for ${[...peers.keys()].join(", ")}. Every other origin ` +
          `goes out over ordinary TLS against the public trust store.`,
      );
    }

    return buildMtlsServerOptions(material, env);
  }

  /** Whether {@link start} brought mTLS up. */
  get enabled(): boolean {
    return this.keyMaterial !== null;
  }

  /** Keeps a listening server's certificate in step with the material. */
  attachTo(server: Pick<TlsServer, "setSecureContext">): void {
    if (this.keyMaterial === null) return;
    this.detachServer?.();
    this.detachServer = attachSecureContextRotation(server, this.keyMaterial);
  }

  /** The dispatcher for `url`, when it names a configured peer. */
  dispatcherFor(url: string): Agent | undefined {
    return this.dispatchers?.dispatcherFor(url);
  }

  /** The key material, for a health indicator or a test. `null` when mTLS is off. */
  material(): MtlsKeyMaterialService | null {
    return this.keyMaterial;
  }

  /** Stops the reload timer and closes every outbound dispatcher. */
  async stop(): Promise<void> {
    this.detachServer?.();
    this.detachServer = null;
    this.keyMaterial?.stop();
    this.keyMaterial = null;
    const dispatchers = this.dispatchers;
    this.dispatchers = null;
    await dispatchers?.close();
  }
}

/**
 * The instance `main.ts` and `ResilientHttpModule` share.
 *
 * One per process, like the telemetry handle, because the material it holds is
 * the process's own identity — a second copy would mean a second reload timer
 * polling the same three files and two answers to "which certificate are we
 * presenting" during the seconds between their ticks.
 */
export const mtls = new MtlsRuntime();

/**
 * Reads the mTLS environment for `main.ts`, before `ConfigService` exists.
 *
 * Re-exported here so bootstrap has one import: the parse and the runtime are
 * used together and nowhere else.
 */
export function readMtlsEnv(env: NodeJS.ProcessEnv = process.env): MtlsEnv {
  return mtlsEnvFromProcess(env);
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is required when MTLS_ENABLED is on. envSchema refuses this configuration at ` +
        `boot; reaching here means the runtime was started with an environment that never ` +
        `went through it.`,
    );
  }
  return value;
}
