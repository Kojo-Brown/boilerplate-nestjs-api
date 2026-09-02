import type { AddressInfo } from "net";
import type { INestApplication } from "@nestjs/common";
import { Role } from "@prisma/client";
import request from "supertest";
import WebSocket from "ws";
import { RealtimeCloseCode, RealtimeGateway, REALTIME_PATH } from "@/realtime";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

interface Frame {
  readonly event: string;
  readonly data: unknown;
}

/**
 * A real `ws` client, driven frame by frame.
 *
 * The unit specs cover the policies with doubles; this suite exists for the
 * things only a real socket can answer — that the upgrade happens at all on the
 * path Nest was told to serve, that a browser-shaped handshake (a token in
 * `Sec-WebSocket-Protocol`) is accepted and echoed, and that a rejected
 * handshake arrives at the client as a close *code* rather than as a hang.
 */
class RealtimeClient {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  closeReason = "";
  openError: Error | null = null;

  private constructor(private readonly socket: WebSocket) {}

  /** Resolves once the socket has either opened or been closed by the server. */
  static async connect(
    port: number,
    options: { token?: string; protocols?: string[]; query?: string } = {},
  ): Promise<RealtimeClient> {
    const url = `ws://127.0.0.1:${port}${REALTIME_PATH}${options.query ?? ""}`;
    const socket = new WebSocket(url, options.protocols ?? [], {
      headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
    });
    const client = new RealtimeClient(socket);

    socket.on("message", (raw: WebSocket.RawData) => {
      client.frames.push(JSON.parse(raw.toString()) as Frame);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      client.closeCode = code;
      client.closeReason = reason.toString();
    });
    socket.on("error", (error: Error) => {
      client.openError = error;
    });

    await new Promise<void>((resolve) => {
      socket.once("open", () => resolve());
      socket.once("close", () => resolve());
      socket.once("error", () => resolve());
    });

    return client;
  }

  get subprotocol(): string {
    return this.socket.protocol;
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(event: string, data: unknown): void {
    this.socket.send(JSON.stringify({ event, data }));
  }

  /** Waits for a frame matching `event`, and returns it. */
  async waitForFrame(event: string, timeoutMs = 3_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find((frame) => frame.event === event);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for "${event}". Received: ${this.frames.map((f) => f.event).join(", ") || "(nothing)"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async waitForClose(timeoutMs = 3_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.closeCode === null) throw new Error("Timed out waiting for the socket to close");
    return this.closeCode;
  }

  close(): void {
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close();
  }
}

describe("WebSocket gateway (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let drainOutbox: TestApp["drainOutbox"];
  let gateway: RealtimeGateway;
  let port: number;

  let userToken: string;
  let userId: string;
  let adminToken: string;

  const clients: RealtimeClient[] = [];

  const connect = async (
    options: { token?: string; protocols?: string[]; query?: string } = {},
  ): Promise<RealtimeClient> => {
    const client = await RealtimeClient.connect(port, options);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    drainOutbox = fixture.drainOutbox;
    gateway = app.get(RealtimeGateway);

    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    prisma.reset();

    const userRes = await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "user@example.com",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Regular User",
    });
    userToken = userRes.body.data.accessToken as string;
    userId = [...prisma._users.values()].find((u) => u.email === "user@example.com")?.id ?? "";

    await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "admin@example.com",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Admin User",
    });
    const adminId =
      [...prisma._users.values()].find((u) => u.email === "admin@example.com")?.id ?? "";
    await prisma.user.update({ where: { id: adminId }, data: { role: Role.ADMIN } });
    const adminLogin = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: process.env["E2E_TEST_PASSWORD"]! });
    adminToken = adminLogin.body.data.accessToken as string;

    // The registrations above staged events. Drain them so each spec starts
    // from a quiet gateway rather than inheriting the fixture's own noise.
    await drainOutbox();
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;

    // A slot that is taken and never released is invisible until the cap is
    // reached, at which point the endpoint refuses everybody — so the leak is
    // asserted against here rather than waited for in production.
    const deadline = Date.now() + 2_000;
    while (gateway.openConnections > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gateway.openConnections).toBe(0);
  });

  describe("the handshake", () => {
    it("upgrades on /v1/realtime and opens with a welcome frame", async () => {
      const client = await connect({ token: userToken });

      expect(client.isOpen).toBe(true);
      const welcome = await client.waitForFrame("realtime.welcome");
      expect(welcome.data).toMatchObject({
        userId,
        role: Role.USER,
        rooms: [`user:${userId}`],
      });
    });

    it("accepts the browser form and echoes the subprotocol back", async () => {
      // `new WebSocket(url, ["bearer", token])` is the only way a browser can
      // present a credential on an upgrade — the constructor cannot set
      // headers. The echo matters: a client whose offered subprotocol is not
      // selected fails the connection.
      const client = await connect({ protocols: ["bearer", userToken] });

      expect(client.isOpen).toBe(true);
      expect(client.subprotocol).toBe("bearer");
      await client.waitForFrame("realtime.welcome");
    });

    it("closes an unauthenticated socket with a code the client can read", async () => {
      const client = await connect();

      expect(await client.waitForClose()).toBe(RealtimeCloseCode.UNAUTHENTICATED);
      expect(client.closeReason).toBe("missing-credentials");
      expect(client.frames).toEqual([]);
    });

    it("refuses a token in the query string, and says which mistake was made", async () => {
      const client = await connect({ query: `?access_token=${userToken}` });

      expect(await client.waitForClose()).toBe(RealtimeCloseCode.UNAUTHENTICATED);
      expect(client.closeReason).toBe("token-in-query");
    });

    it("closes a socket whose token does not verify", async () => {
      const client = await connect({ token: `${userToken}tampered` });

      expect(await client.waitForClose()).toBe(RealtimeCloseCode.UNAUTHENTICATED);
      expect(client.closeReason).toBe("invalid-token");
    });
  });

  describe("rooms", () => {
    it("delivers an event to its subject over a real socket, with no subscribe needed", async () => {
      // The registration stages `user.registered` in the outbox; the relay's
      // timer is off in this suite, so nothing reaches the bus — and therefore
      // the gateway — until `drainOutbox`. Connecting in between is what makes
      // this an assertion about delivery rather than about replay.
      const registration = await request(app.getHttpServer()).post("/v1/auth/register").send({
        email: "newcomer@example.com",
        password: process.env["E2E_TEST_PASSWORD"]!,
        name: "Newcomer",
      });
      const newcomerToken = registration.body.data.accessToken as string;
      const newcomerId =
        [...prisma._users.values()].find((u) => u.email === "newcomer@example.com")?.id ?? "";

      const client = await connect({ token: newcomerToken });
      await client.waitForFrame("realtime.welcome");

      await drainOutbox();

      const frame = await client.waitForFrame("user.registered");
      expect(frame.data).toMatchObject({
        name: "user.registered",
        payload: { userId: newcomerId, email: "newcomer@example.com" },
      });
    });

    it("lets an administrator subscribe to a catalogue-wide room and receive another account's event", async () => {
      const client = await connect({ token: adminToken });
      await client.waitForFrame("realtime.welcome");

      client.send("subscribe", { rooms: ["events:user.registered"] });
      const ack = await client.waitForFrame("realtime.subscribed");
      expect(ack.data).toMatchObject({ rooms: ["events:user.registered"] });

      await request(app.getHttpServer()).post("/v1/auth/register").send({
        email: "newcomer@example.com",
        password: process.env["E2E_TEST_PASSWORD"]!,
        name: "Newcomer",
      });
      await drainOutbox();

      const frame = await client.waitForFrame("user.registered");
      expect(frame.data).toMatchObject({ payload: { email: "newcomer@example.com" } });
    });

    it("refuses another account's room and delivers nothing from it", async () => {
      const client = await connect({ token: userToken });
      await client.waitForFrame("realtime.welcome");

      client.send("subscribe", { rooms: ["events:user.registered"] });
      const error = await client.waitForFrame("realtime.error");
      expect(error.data).toMatchObject({ code: "forbidden-room" });

      await request(app.getHttpServer()).post("/v1/auth/register").send({
        email: "newcomer@example.com",
        password: process.env["E2E_TEST_PASSWORD"]!,
        name: "Newcomer",
      });
      await drainOutbox();

      // Give the fan-out a chance to be wrong before concluding it was not.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.frames.map((f) => f.event)).not.toContain("user.registered");
    });

    it("answers a malformed frame instead of dropping the connection", async () => {
      // Nest's `WsAdapter` swallows a handler that throws, so "the server said
      // nothing" is exactly what a validation bug looks like from a client.
      const client = await connect({ token: userToken });
      await client.waitForFrame("realtime.welcome");

      client.send("subscribe", { room: "user:me" });

      const error = await client.waitForFrame("realtime.error");
      expect(error.data).toMatchObject({ code: "malformed-payload" });
      expect(client.isOpen).toBe(true);
    });

    it("ignores an unknown message type without closing the connection", async () => {
      const client = await connect({ token: userToken });
      await client.waitForFrame("realtime.welcome");

      client.send("teleport", {});
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(client.isOpen).toBe(true);
      expect(gateway.openConnections).toBe(1);
    });
  });

  describe("cleanup", () => {
    it("releases the slot when a client disconnects", async () => {
      const client = await connect({ token: userToken });
      await client.waitForFrame("realtime.welcome");
      expect(gateway.openConnections).toBe(1);

      client.close();

      const deadline = Date.now() + 2_000;
      while (gateway.openConnections > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(gateway.openConnections).toBe(0);
    });

    it("never counts a refused handshake as an open connection", async () => {
      await connect();
      await connect({ token: "not-a-token" });

      expect(gateway.openConnections).toBe(0);
    });
  });
});
