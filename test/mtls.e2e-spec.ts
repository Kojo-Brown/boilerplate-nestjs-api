import { Controller, Get, INestApplication, Module, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createServer } from "node:https";
import type { Server } from "node:https";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { z } from "zod";
import { HttpTransportError, ResilientHttpClient } from "@/common/http";
import type { ResilientHttpOptions } from "@/common/http";
import {
  MtlsKeyMaterialService,
  MtlsPeerGuard,
  buildMtlsServerOptions,
  createPeerAgent,
  loadKeyMaterial,
  mtlsEnvShape,
} from "@/common/mtls";
import type { MtlsEnv } from "@/common/mtls";
import { createTestCertificateAuthority } from "@/test-utils/test-certificates";
import type { TestCertificateAuthority } from "@/test-utils/test-certificates";
import { stubConfig } from "@/test-utils/stub-config";

/**
 * Mutual TLS end to end: a real TLS listener, a real handshake, real
 * certificates issued for this run, and the same guard the application binds.
 *
 * Everything in `src/common/mtls` is unit tested against material on disk, and
 * none of that exercises the part that actually matters — whether a peer gets
 * in. A handshake is a conversation between two OpenSSL instances, and the
 * questions this suite asks (does an unknown CA get refused before HTTP starts,
 * does a valid certificate for the wrong workload get a 403, does a rotation
 * reach the next connection) have no answer that can be mocked.
 *
 * The application is a two-route Nest module rather than `AppModule`: what is
 * under test is the listener and the guard, and booting the whole container
 * would add a database, a broker and a Redis to a suite about a socket.
 */

const envSchema = z.object(mtlsEnvShape);

const SERVER_IDENTITY = "spiffe://cluster.local/ns/prod/sa/api";
const CLIENT_IDENTITY = "spiffe://cluster.local/ns/prod/sa/web";
const STRANGER_IDENTITY = "spiffe://cluster.local/ns/dev/sa/scratch";

@Controller({ path: "orders", version: "1" })
class OrdersController {
  @Get()
  list(): { orders: [] } {
    return { orders: [] };
  }
}

@Controller({ path: "health", version: "1" })
class HealthController {
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}

/** One listener: a Nest application behind a TLS server built from the material. */
interface Listener {
  readonly app: INestApplication;
  readonly server: Server;
  readonly url: string;
  readonly material: MtlsKeyMaterialService;
  close(): Promise<void>;
}

const directories: string[] = [];
const agents: Agent[] = [];
const clients: ResilientHttpClient[] = [];

/** Writes a leaf, its key and a trust bundle, and loads them. */
function mount(
  ca: TestCertificateAuthority,
  identity: string,
  options: { anchors?: string; dnsName?: string } = {},
): { files: { certFile: string; keyFile: string; caFile: string }; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "mtls-e2e-"));
  directories.push(directory);
  const issued = ca.issue({
    commonName: identity,
    subjectAltNames: [
      `URI:${identity}`,
      ...(options.dnsName === undefined ? [] : [`DNS:${options.dnsName}`]),
    ],
  });
  const files = {
    certFile: join(directory, "tls.crt"),
    keyFile: join(directory, "tls.key"),
    caFile: join(directory, "ca.crt"),
  };
  writeFileSync(files.certFile, issued.certPem);
  writeFileSync(files.keyFile, issued.keyPem);
  writeFileSync(files.caFile, options.anchors ?? ca.certPem);
  return { files, directory };
}

async function listen(
  files: { certFile: string; keyFile: string; caFile: string },
  env: MtlsEnv,
): Promise<Listener> {
  const material = new MtlsKeyMaterialService({
    files,
    reloadIntervalMs: 0,
    expiryWarningDays: 0,
    now: () => new Date(),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  const loaded = material.start();

  @Module({
    controllers: [OrdersController, HealthController],
    providers: [
      { provide: ConfigService, useValue: stubConfig({ ...env }) },
      { provide: APP_GUARD, useClass: MtlsPeerGuard },
    ],
  })
  class MtlsTestModule {}

  const app = await Test.createTestingModule({ imports: [MtlsTestModule] })
    .compile()
    .then((m) => m.createNestApplication({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  await app.init();

  // The TLS server wraps the Express instance Nest has already configured,
  // which is what `NestFactory.create({ httpsOptions })` does one layer down.
  const server = createServer(
    buildMtlsServerOptions(loaded, env),
    app.getHttpAdapter().getInstance(),
  );
  // New connections pick up rotated material; this is the line `main.ts` runs
  // through `mtls.attachTo`.
  material.onRotate((rotated) =>
    server.setSecureContext({ cert: rotated.cert, key: rotated.key, ca: [...rotated.ca] }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    app,
    server,
    material,
    url: `https://localhost:${port}`,
    close: async () => {
      material.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}

/** A client that presents `files`' certificate and expects `expectedIdentity` back. */
function clientFor(
  files: { certFile: string; keyFile: string; caFile: string },
  expectedIdentity: string,
): Agent {
  const agent = createPeerAgent(loadKeyMaterial(files, { now: new Date() }), expectedIdentity);
  agents.push(agent);
  return agent;
}

/**
 * The client half, as the application actually makes a call.
 *
 * `ResilientHttpClient` rather than a bare `fetch`, because the dispatcher
 * reaching the socket is the wiring under test: `dispatcherFor` is consulted by
 * the client, threaded through the breaker and handed to `fetch` by
 * `json-http`. One attempt, because a refused handshake is not a flake and
 * three of them would only make the suite slower.
 */
function callerThrough(dispatcher: Agent): ResilientHttpClient {
  const options: ResilientHttpOptions = {
    retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    breaker: {
      failureThresholdPercent: 100,
      volumeThreshold: 100,
      rollingWindowMs: 10_000,
      rollingBuckets: 10,
      resetTimeoutMs: 1_000,
    },
    bulkhead: { maxConcurrent: 10, maxQueued: 10, maxQueueWaitMs: 1_000 },
    deadlineMs: 10_000,
    sleep: async () => {},
    random: () => 0.5,
    now: () => performance.now(),
    dispatcherFor: () => dispatcher,
  };
  const client = new ResilientHttpClient(options);
  clients.push(client);
  return client;
}

/**
 * The reason a request failed to get a response, as a string worth asserting on.
 *
 * `rejects.toThrow()` alone would pass for any failure at all — a typo in the
 * URL, a closed server, a bug in the suite — and every refusal in this file is
 * a case where passing for the wrong reason would look exactly like passing.
 */
async function failureReason(url: string, dispatcher: Agent): Promise<string> {
  try {
    const response = await callerThrough(dispatcher).request(url, url, { method: "GET" });
    throw new Error(`Expected the request to fail; it returned ${String(response.status)}.`);
  } catch (error) {
    if (!(error instanceof HttpTransportError)) throw error;
    // Read structurally rather than with `instanceof Error`: the rejection
    // `fetch` produces is constructed inside Node's own realm, where it is not
    // an instance of this test realm's `Error` — the same trap
    // `mtls-dispatcher.spec.ts` documents for `checkServerIdentity`.
    const cause: unknown = error.cause;
    const nested: unknown = (cause as { cause?: unknown } | undefined)?.cause;
    return [cause, nested]
      .flatMap((value) => [
        (value as { code?: unknown } | undefined)?.code,
        (value as { message?: unknown } | undefined)?.message,
      ])
      .filter((part): part is string => typeof part === "string")
      .join(" ");
  }
}

/** A client with no certificate of its own, which is what a kubelet probe is. */
function anonymousClient(caPem: string): Agent {
  const agent = new Agent({ connect: { ca: [caPem] } });
  agents.push(agent);
  return agent;
}

function baseEnv(overrides: Record<string, unknown> = {}): MtlsEnv {
  return envSchema.parse({
    MTLS_ENABLED: true,
    MTLS_CERT_FILE: "/unused-by-the-guard",
    MTLS_KEY_FILE: "/unused-by-the-guard",
    MTLS_CA_FILE: "/unused-by-the-guard",
    MTLS_ALLOWED_CLIENTS: CLIENT_IDENTITY,
    MTLS_EXEMPT_PREFIXES: "",
    ...overrides,
  });
}

afterAll(async () => {
  for (const client of clients) client.onApplicationShutdown();
  await Promise.allSettled(agents.map((agent) => agent.close()));
});

describe("mutual TLS — who gets in", () => {
  let ca: TestCertificateAuthority;
  let listener: Listener;
  let client: Agent;

  beforeAll(async () => {
    ca = createTestCertificateAuthority("E2E Root CA");
    const server = mount(ca, SERVER_IDENTITY, { dnsName: "localhost" });
    listener = await listen(server.files, baseEnv());
    client = clientFor(mount(ca, CLIENT_IDENTITY).files, SERVER_IDENTITY);
  });

  afterAll(async () => {
    await listener.close();
  });

  it("serves a peer on the allowlist", async () => {
    const response = await callerThrough(client).request("api", `${listener.url}/v1/orders`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ orders: [] });
  });

  /**
   * The distinction the allowlist exists for. This certificate is signed by the
   * same CA as the one above, is in date, and belongs to a workload that is a
   * perfectly legitimate member of the trust domain. It still does not call
   * this service.
   */
  it("refuses a workload the CA vouches for and the allowlist does not name", async () => {
    const stranger = clientFor(mount(ca, STRANGER_IDENTITY).files, SERVER_IDENTITY);

    const response = await callerThrough(stranger).request("api", `${listener.url}/v1/orders`, {
      method: "GET",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      message: expect.stringContaining("unknown-identity"),
    });
  });

  /**
   * Refused during the handshake, by OpenSSL, before Node sees a byte — which
   * is why this assertion is about a connection error rather than a status.
   */
  it("refuses a certificate from a CA it does not trust", async () => {
    const otherCa = createTestCertificateAuthority("Impostor Root CA");
    // Its bundle carries both anchors — its own, because material whose leaf
    // does not chain to its own bundle is refused at load (see
    // `docs/mtls.md` on the single-trust-domain assumption), and this
    // service's, so the client is happy with the server. It is the server that
    // has never heard of this CA.
    const impostor = clientFor(
      mount(otherCa, CLIENT_IDENTITY, { anchors: `${otherCa.certPem}${ca.certPem}` }).files,
      SERVER_IDENTITY,
    );

    expect(await failureReason(`${listener.url}/v1/orders`, impostor)).toMatch(
      /UND_ERR_SOCKET|alert|closed/i,
    );
  });

  it("refuses a caller with no certificate at all", async () => {
    const anonymous = anonymousClient(ca.certPem);

    expect(await failureReason(`${listener.url}/v1/orders`, anonymous)).toMatch(
      /UND_ERR_SOCKET|alert|closed/i,
    );
  });

  it("refuses a peer whose certificate carries the right identity for the wrong service", async () => {
    // The client is verifying too: this listener's certificate says `api`, and
    // a client told to expect `orders` must not accept it however valid the
    // chain is.
    const misdirected = clientFor(
      mount(ca, CLIENT_IDENTITY).files,
      "spiffe://cluster.local/ns/prod/sa/orders",
    );

    // Refused by our own `checkServerIdentity`, so the message is the one
    // `verifyPeerCertificate` writes rather than an OpenSSL alert.
    expect(await failureReason(`${listener.url}/v1/orders`, misdirected)).toContain(
      "MTLS_PEERS expects spiffe://cluster.local/ns/prod/sa/orders",
    );
  });
});

describe("mutual TLS — unauthenticated probes", () => {
  let ca: TestCertificateAuthority;
  let listener: Listener;

  beforeAll(async () => {
    ca = createTestCertificateAuthority("Probe Root CA");
    const server = mount(ca, SERVER_IDENTITY, { dnsName: "localhost" });
    listener = await listen(
      server.files,
      baseEnv({
        MTLS_ALLOW_UNAUTHENTICATED_PROBES: true,
        MTLS_EXEMPT_PREFIXES: "/v1/health",
      }),
    );
  });

  afterAll(async () => {
    await listener.close();
  });

  it("lets a kubelet reach the exempt path with no certificate", async () => {
    const response = await callerThrough(anonymousClient(ca.certPem)).request(
      "api",
      `${listener.url}/v1/health`,
      { method: "GET" },
    );

    expect(response.status).toBe(200);
  });

  /**
   * The cost of the setting above, and the reason the guard checks
   * `socket.authorized` even though the TLS layer usually has: with
   * unauthenticated connections accepted, this refusal is the only one there is.
   */
  it("still refuses everything else, now at the request rather than the handshake", async () => {
    const response = await callerThrough(anonymousClient(ca.certPem)).request(
      "api",
      `${listener.url}/v1/orders`,
      { method: "GET" },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      message: expect.stringContaining("no-certificate"),
    });
  });
});

describe("mutual TLS — rotation", () => {
  let ca: TestCertificateAuthority;
  let listener: Listener;
  let files: { certFile: string; keyFile: string; caFile: string };

  beforeAll(async () => {
    ca = createTestCertificateAuthority("Rotation Root CA");
    const server = mount(ca, SERVER_IDENTITY, { dnsName: "localhost" });
    files = server.files;
    listener = await listen(files, baseEnv());
  });

  afterAll(async () => {
    await listener.close();
  });

  /** What the server presented, as the client saw it during the handshake. */
  async function fingerprintSeenByClient(): Promise<string> {
    let seen = "";
    const agent = new Agent({
      connect: {
        ca: [ca.certPem],
        cert: readFileSync(clientFiles.certFile, "utf8"),
        key: readFileSync(clientFiles.keyFile, "utf8"),
        checkServerIdentity: (_host, certificate) => {
          seen = certificate.fingerprint256;
          return undefined;
        },
      },
    });
    agents.push(agent);
    const response = await callerThrough(agent).request("api", `${listener.url}/v1/orders`, {
      method: "GET",
    });
    expect(response.status).toBe(200);
    await agent.close();
    return seen;
  }

  let clientFiles: { certFile: string; keyFile: string; caFile: string };

  beforeAll(() => {
    clientFiles = mount(ca, CLIENT_IDENTITY).files;
  });

  it("presents the new certificate on the next connection after a reload", async () => {
    const before = await fingerprintSeenByClient();

    // The rotation itself: new leaf and key written over the mounted paths,
    // exactly as a secret update does it.
    const replacement = ca.issue({
      commonName: SERVER_IDENTITY,
      subjectAltNames: [`URI:${SERVER_IDENTITY}`, "DNS:localhost"],
    });
    writeFileSync(files.certFile, replacement.certPem);
    writeFileSync(files.keyFile, replacement.keyPem);
    expect(listener.material.reload()).toBe("rotated");

    const after = await fingerprintSeenByClient();

    expect(after).not.toBe(before);
  });

  /**
   * The first half of a CA rotation: the trust bundle learns the next anchor
   * while every workload is still presenting certificates from the old one. A
   * client from the new CA is refused before it and served after it, with no
   * restart in between.
   */
  it("accepts a client from a newly trusted CA once the bundle is reloaded", async () => {
    const nextCa = createTestCertificateAuthority("Next Root CA");
    // The newcomer trusts both anchors, which is how a CA rotation is actually
    // run: everyone carries the union of the two while the leaves move over.
    const bothAnchors = `${nextCa.certPem}${ca.certPem}`;
    const newcomer = clientFor(
      mount(nextCa, CLIENT_IDENTITY, { anchors: bothAnchors }).files,
      SERVER_IDENTITY,
    );

    expect(await failureReason(`${listener.url}/v1/orders`, newcomer)).toMatch(
      /UND_ERR_SOCKET|alert|closed/i,
    );

    writeFileSync(files.caFile, bothAnchors);
    expect(listener.material.reload()).toBe("rotated");

    // A fresh dispatcher, because the refused one is holding a socket that was
    // never going to complete a handshake.
    const retry = clientFor(
      mount(nextCa, CLIENT_IDENTITY, { anchors: bothAnchors }).files,
      SERVER_IDENTITY,
    );
    const response = await callerThrough(retry).request("api", `${listener.url}/v1/orders`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
  });
});
