import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCertificateAuthority } from "@/test-utils/test-certificates";
import { loadKeyMaterial } from "./key-material";
import type { KeyMaterial } from "./key-material";
import { MtlsKeyMaterialService } from "./key-material.service";
import {
  attachSecureContextRotation,
  buildMtlsServerOptions,
  secureContextFrom,
} from "./mtls-server";
import { mtlsEnvShape } from "./mtls.env";
import { z } from "zod";

const IDENTITY = "spiffe://cluster.local/ns/prod/sa/orders";
const NOW = new Date(Date.now() + 60_000);
const envSchema = z.object(mtlsEnvShape);

const directory = mkdtempSync(join(tmpdir(), "mtls-server-"));
const ca = createTestCertificateAuthority();

function writeMaterial(identity: string): KeyMaterial {
  const issued = ca.issue({ commonName: "orders", subjectAltNames: [`URI:${identity}`] });
  const certFile = join(directory, "tls.crt");
  const keyFile = join(directory, "tls.key");
  const caFile = join(directory, "ca.crt");
  writeFileSync(certFile, issued.certPem);
  writeFileSync(keyFile, issued.keyPem);
  writeFileSync(caFile, ca.certPem);
  return loadKeyMaterial({ certFile, keyFile, caFile }, { now: NOW });
}

describe("buildMtlsServerOptions", () => {
  const material = writeMaterial(IDENTITY);

  it("always asks for a client certificate, because nothing else does", () => {
    const options = buildMtlsServerOptions(material, envSchema.parse({ MTLS_ENABLED: true }));

    expect(options.requestCert).toBe(true);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.minVersion).toBe("TLSv1.2");
    expect(options.cert).toBe(material.cert);
    expect(options.ca).toEqual([...material.ca]);
  });

  /**
   * The probe trade-off, made explicit: with unauthenticated probes allowed the
   * TLS layer stops refusing anyone, and every refusal moves to the guard.
   */
  it("stops rejecting at the TLS layer when unauthenticated probes are allowed in", () => {
    const options = buildMtlsServerOptions(
      material,
      envSchema.parse({ MTLS_ENABLED: true, MTLS_ALLOW_UNAUTHENTICATED_PROBES: true }),
    );

    expect(options.requestCert).toBe(true);
    expect(options.rejectUnauthorized).toBe(false);
  });

  it("carries the passphrase through, since the context is built from an encrypted key", () => {
    const issued = ca.issue({
      commonName: "encrypted",
      subjectAltNames: [`URI:${IDENTITY}`],
      encryptKeyWith: "not-a-real-passphrase",
    });
    const caFile = join(directory, "ca.crt");
    const encrypted = loadKeyMaterial(
      { certFile: issued.certFile, keyFile: issued.keyFile, caFile },
      { now: NOW, passphrase: "not-a-real-passphrase" },
    );

    expect(secureContextFrom(encrypted).passphrase).toBe("not-a-real-passphrase");
  });
});

describe("attachSecureContextRotation", () => {
  it("hands the server a new context when the material rotates, and stops on unsubscribe", () => {
    writeMaterial(IDENTITY);
    const service = new MtlsKeyMaterialService({
      files: {
        certFile: join(directory, "tls.crt"),
        keyFile: join(directory, "tls.key"),
        caFile: join(directory, "ca.crt"),
      },
      reloadIntervalMs: 0,
      expiryWarningDays: 0,
      now: () => NOW,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    service.start();
    const setSecureContext = jest.fn();
    const detach = attachSecureContextRotation({ setSecureContext }, service);

    writeMaterial("spiffe://cluster.local/ns/prod/sa/orders-v2");
    service.reload();

    expect(setSecureContext).toHaveBeenCalledTimes(1);
    expect(setSecureContext).toHaveBeenCalledWith(secureContextFrom(service.current()));
    // The options a running server cannot be given again: `requestCert` and
    // `rejectUnauthorized` belong to the server, not to the context.
    expect(setSecureContext.mock.calls[0]?.[0]).not.toHaveProperty("requestCert");

    detach();
    writeMaterial("spiffe://cluster.local/ns/prod/sa/orders-v3");
    service.reload();
    expect(setSecureContext).toHaveBeenCalledTimes(1);

    service.stop();
  });
});
