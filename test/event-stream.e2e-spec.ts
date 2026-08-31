import http from "http";
import type { AddressInfo } from "net";
import type { INestApplication } from "@nestjs/common";
import { Role } from "@prisma/client";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import { EventStreamHub } from "@/streaming";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

/** One SSE frame, as parsed off the wire rather than as the server built it. */
interface Frame {
  /** The SSE event type. `"message"` when the server sent no `event:` line. */
  readonly event: string;
  readonly id?: string;
  readonly retry?: number;
  /** Absent when the frame carried no `data:` line at all — see the heartbeat. */
  readonly data?: string;
  readonly raw: string;
}

/**
 * A deliberately literal SSE client.
 *
 * Supertest buffers a response to completion, which a stream that never ends
 * does not have, so this speaks to the server over a real socket and parses the
 * bytes itself. Parsing rather than asserting on substrings is what lets the
 * suite tell `id: x` with no `data:` line from `data: ""` — the distinction the
 * heartbeat design rests on, and one that `toContain` cannot see.
 */
class SseClient {
  readonly frames: Frame[] = [];
  statusCode = 0;
  headers: http.IncomingHttpHeaders = {};

  private pending = "";
  private request?: http.ClientRequest;
  private failure?: Error;

  static async open(
    port: number,
    token: string,
    options: { lastEventIdHeader?: string; query?: string } = {},
  ): Promise<SseClient> {
    const client = new SseClient();
    await client.connect(port, token, options);
    return client;
  }

  private connect(
    port: number,
    token: string,
    options: { lastEventIdHeader?: string; query?: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      };
      if (options.lastEventIdHeader !== undefined) {
        headers["Last-Event-ID"] = options.lastEventIdHeader;
      }

      this.request = http.get(
        { host: "127.0.0.1", port, path: `/v1/events/stream${options.query ?? ""}`, headers },
        (res) => {
          this.statusCode = res.statusCode ?? 0;
          this.headers = res.headers;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => this.consume(chunk));
          res.on("error", (error) => {
            this.failure = error;
          });
          resolve();
        },
      );
      this.request.on("error", reject);
    });
  }

  private consume(chunk: string): void {
    this.pending += chunk;

    // Frames are separated by a blank line. The stream opens with one on its
    // own (Nest writes `\n` when it commits the headers), which parses to
    // nothing and is dropped.
    let boundary = this.pending.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 2);
      const frame = SseClient.parse(raw);
      if (frame) this.frames.push(frame);
      boundary = this.pending.indexOf("\n\n");
    }
  }

  private static parse(raw: string): Frame | null {
    if (raw.trim() === "") return null;

    let event = "message";
    let id: string | undefined;
    let retry: number | undefined;
    const data: string[] = [];

    for (const line of raw.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "retry") retry = Number(value);
      else if (field === "data") data.push(value);
    }

    return { event, id, retry, data: data.length > 0 ? data.join("\n") : undefined, raw };
  }

  /** Waits until `predicate` holds over the frames received so far. */
  async waitFor(predicate: (frames: Frame[]) => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      if (predicate(this.frames)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${label}. Frames so far: ${JSON.stringify(this.frames)}`,
    );
  }

  of(event: string): Frame[] {
    return this.frames.filter((frame) => frame.event === event);
  }

  body<T>(frame: Frame): T {
    return JSON.parse(frame.data ?? "null") as T;
  }

  close(): void {
    this.request?.destroy();
  }
}

describe("Event stream (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let hub: EventStreamHub;
  let drainOutbox: TestApp["drainOutbox"];
  let port: number;

  let userToken: string;
  let adminToken: string;
  let userId: string;

  const clients: SseClient[] = [];

  const openStream = async (
    token: string,
    options: { lastEventIdHeader?: string; query?: string } = {},
  ): Promise<SseClient> => {
    const client = await SseClient.open(port, token, options);
    clients.push(client);
    return client;
  };

  /**
   * Registers a user and delivers the resulting `user.registered`.
   *
   * The event is staged in the outbox inside the registration's transaction, and
   * the relay's timer is off in this suite — so nothing reaches the bus, and
   * therefore the stream, until it is drained. That latency is the outbox's
   * bargain rather than test scaffolding; making it explicit is what keeps this
   * suite from being a race.
   */
  const registerAndDeliver = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/register")
      .send({ email, password: process.env["E2E_TEST_PASSWORD"]!, name: "Streamed User" });
    await drainOutbox();
    return [...prisma._users.values()].find((u) => u.email === email)?.id ?? res.body.data.userId;
  };

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    drainOutbox = fixture.drainOutbox;
    hub = app.get(EventStreamHub);

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

    // Registrations above staged events; drain them so each spec starts from a
    // quiet stream rather than inheriting the fixture's own noise.
    await drainOutbox();
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;

    // Every spec must leave the hub as it found it. A slot that is taken and
    // never released is invisible until the cap is reached, at which point the
    // endpoint 503s everybody — so the leak is asserted against here rather
    // than waited for in production.
    const deadline = Date.now() + 2_000;
    while (hub.openConnections > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hub.openConnections).toBe(0);
  });

  describe("access", () => {
    it("rejects an unauthenticated subscriber", async () => {
      await request(app.getHttpServer()).get("/v1/events/stream").expect(401);
    });

    it("rejects an unrecognised query parameter, like every other route", async () => {
      await request(app.getHttpServer())
        .get("/v1/events/stream?nonsense=1")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  describe("the opening frame", () => {
    it("answers as an event stream that no proxy should buffer", async () => {
      const client = await openStream(adminToken);
      await client.waitFor((frames) => frames.length > 0, "the opening frame");

      expect(client.statusCode).toBe(200);
      expect(client.headers["content-type"]).toContain("text/event-stream");
      expect(client.headers["cache-control"]).toContain("no-cache");
      expect(client.headers["x-accel-buffering"]).toBe("no");
    });

    it("opens with stream.open, carrying the retry hint and a cursor", async () => {
      const client = await openStream(adminToken);
      await client.waitFor((frames) => frames.length > 0, "the opening frame");

      const open = client.frames[0]!;
      expect(open.event).toBe("stream.open");
      expect(open.retry).toBe(500);
      expect(open.id).toMatch(/^[0-9a-f]{32}\.\d+$/);
      expect(client.body<{ gap: null; resumed: boolean }>(open)).toMatchObject({
        resumed: false,
        gap: null,
      });
    });
  });

  describe("delivery", () => {
    /**
     * The `@SkipResponseEnvelope()` pin.
     *
     * Nest applies the global interceptors to an SSE handler's stream of
     * frames, not to its return value, so without that decorator
     * `ResponseEnvelopeInterceptor` would `map` each frame to `{ success, data,
     * meta }` — an object with no `type` and no `id`. Every frame would then
     * arrive as an unnamed `message` and no client would ever be given a
     * cursor, which is a resume that fails silently rather than loudly.
     * Asserting the event name and the id is what makes removing the decorator
     * fail here.
     */
    it("delivers a domain event under its own name, unenveloped", async () => {
      const client = await openStream(adminToken);
      await client.waitFor((frames) => frames.length > 0, "the opening frame");

      await registerAndDeliver("streamed@example.com");
      await client.waitFor((f) => f.some((x) => x.event === "user.registered"), "the event");

      const frame = client.of("user.registered")[0]!;
      expect(frame.id).toMatch(/^[0-9a-f]{32}\.\d+$/);
      expect(client.body<Record<string, unknown>>(frame)).toMatchObject({
        name: "user.registered",
        payload: { email: "streamed@example.com" },
      });
      expect(frame.data).not.toContain('"success"');
      expect(frame.data).not.toContain('"meta"');
    });

    it("does not show one user another user's registration", async () => {
      const mine = await openStream(userToken);
      const theirs = await openStream(adminToken);
      await mine.waitFor((frames) => frames.length > 0, "the opening frame");
      await theirs.waitFor((frames) => frames.length > 0, "the opening frame");

      await registerAndDeliver("someone-else@example.com");
      await theirs.waitFor((f) => f.some((x) => x.event === "user.registered"), "the event");

      expect(mine.of("user.registered")).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    /**
     * The keep-alive has to reach the client — otherwise a proxy closes the
     * idle connection — while dispatching no event, so that ignoring it is not
     * part of the wire contract. Those two requirements meet in a frame with an
     * `id` and no `data:` line, which the SSE specification says updates the
     * client's last event ID and returns without dispatching. This asserts the
     * bytes, because that is the only place the property is visible.
     */
    it("keeps the connection warm with a frame that dispatches no event", async () => {
      const client = await openStream(adminToken);
      await client.waitFor((f) => f.some((x) => x.event === "stream.heartbeat"), "a heartbeat");

      const heartbeat = client.of("stream.heartbeat")[0]!;
      expect(heartbeat.id).toMatch(/^[0-9a-f]{32}\.\d+$/);
      expect(heartbeat.data).toBeUndefined();
      expect(heartbeat.raw).not.toContain("data:");
    });

    it("keeps sending them for as long as the connection is idle", async () => {
      const client = await openStream(adminToken);
      await client.waitFor((f) => f.filter((x) => x.event === "stream.heartbeat").length >= 3, "3");

      expect(client.of("stream.heartbeat").length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("resume", () => {
    it("replays what was missed, from the Last-Event-ID header", async () => {
      const first = await openStream(adminToken);
      await first.waitFor((frames) => frames.length > 0, "the opening frame");
      const cursor = first.frames[0]!.id!;
      first.close();

      await registerAndDeliver("missed-one@example.com");
      await registerAndDeliver("missed-two@example.com");

      const resumed = await openStream(adminToken, { lastEventIdHeader: cursor });
      await resumed.waitFor(
        (f) => f.filter((x) => x.event === "user.registered").length >= 2,
        "the replayed events",
      );

      expect(
        resumed.body<{ resumed: boolean; replayed: number }>(resumed.frames[0]!),
      ).toMatchObject({ resumed: true, replayed: 2 });
      expect(
        resumed.of("user.registered").map((f) => resumed.body<{ payload: { email: string } }>(f)),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ email: "missed-one@example.com" }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ email: "missed-two@example.com" }),
        }),
      ]);
    });

    /**
     * `EventSource` cannot set a header on the connection it opens — only on
     * the reconnects it performs itself — so a client resuming after a page
     * reload has nowhere but the query string to put its cursor.
     */
    it("accepts the cursor in the query string, for clients that cannot set a header", async () => {
      const first = await openStream(adminToken);
      await first.waitFor((frames) => frames.length > 0, "the opening frame");
      const cursor = first.frames[0]!.id!;
      first.close();

      await registerAndDeliver("missed-three@example.com");

      const resumed = await openStream(adminToken, {
        query: `?lastEventId=${encodeURIComponent(cursor)}`,
      });
      await resumed.waitFor((f) => f.some((x) => x.event === "user.registered"), "the replay");

      expect(resumed.body<{ replayed: number }>(resumed.frames[0]!).replayed).toBe(1);
    });

    it("reports a cursor it cannot honour instead of pretending to resume", async () => {
      const client = await openStream(adminToken, {
        lastEventIdHeader: `${"a".repeat(32)}.3`,
      });
      await client.waitFor((frames) => frames.length > 0, "the opening frame");

      expect(client.body<{ resumed: boolean; gap: string }>(client.frames[0]!)).toMatchObject({
        resumed: false,
        gap: "epoch-changed",
      });
    });
  });

  describe("cleanup", () => {
    it("releases the connection when the client goes away", async () => {
      const client = await openStream(adminToken);
      await client.waitFor((frames) => frames.length > 0, "the opening frame");
      expect(hub.openConnections).toBe(1);

      client.close();

      const deadline = Date.now() + 2_000;
      while (hub.openConnections > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(hub.openConnections).toBe(0);
    });

    it("releases every connection a user opened", async () => {
      const one = await openStream(userToken);
      const two = await openStream(userToken);
      await one.waitFor((frames) => frames.length > 0, "the opening frame");
      await two.waitFor((frames) => frames.length > 0, "the opening frame");
      expect(hub.openConnections).toBe(2);

      one.close();
      two.close();

      const deadline = Date.now() + 2_000;
      while (hub.openConnections > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(hub.openConnections).toBe(0);
      expect(userId).not.toBe("");
    });
  });
});
