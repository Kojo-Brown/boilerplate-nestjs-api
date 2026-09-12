import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { TransactionalOutbox } from "@/outbox";
import { extractTraceContext, TRACEPARENT_HEADER } from "@/telemetry";
import { realEventContract } from "@/test-utils/event-contract";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
import { InMemoryBroker } from "./in-memory-broker";
import { BrokerOutboxPublisher } from "./broker-outbox.publisher";
import type { IncomingMessage } from "./ports";

const TOPIC = "domain-events";
const contract = realEventContract();
const HOUR = 3_600_000;

const payload = {
  userId: "user-1",
  email: "ada@example.test",
  name: "Ada",
  provider: null,
} as const;

/**
 * The one property W3C trace context exists to give this architecture, end to
 * end, through the two seams that would otherwise break it.
 *
 * An event is staged inside a request, in one transaction. It is published by a
 * poller — later, possibly in another replica, under a trace context that
 * describes the poll and nothing else. It is then consumed by a third process
 * that has never seen either. Nothing about that chain reconstructs itself: it
 * holds together only because the staging context is written to the row and the
 * publish context is written to the message.
 *
 * Asserted here rather than in each unit's own spec, because every one of those
 * units can be individually correct while the chain is still broken — which is
 * exactly what a `traceparent` captured at publish time rather than at stage
 * time would look like.
 */
describe("trace context across the outbox and the broker", () => {
  let probe: TelemetryProbe;
  let broker: InMemoryBroker;
  let store: InMemoryOutboxStore;
  let transactions: InMemoryTransactionRunner;
  let outbox: TransactionalOutbox;
  let publisher: BrokerOutboxPublisher;
  let delivered: IncomingMessage[];

  beforeEach(async () => {
    probe = installInMemoryTelemetry();
    broker = new InMemoryBroker({ defaultPartitions: 1 });
    await broker.connect();
    store = new InMemoryOutboxStore();
    transactions = new InMemoryTransactionRunner();
    outbox = new TransactionalOutbox(store, contract);
    publisher = new BrokerOutboxPublisher(broker, TOPIC, contract);

    delivered = [];
    await broker.subscribe({
      groupId: "spec",
      topics: [TOPIC],
      fromBeginning: true,
      handle: async (message) => {
        delivered.push(message);
      },
    });
  });

  afterEach(async () => {
    await broker.disconnect();
    await probe.shutdown();
  });

  /** One drain, run — as in production — with no request context active. */
  const relay = () =>
    store.drain({
      now: new Date(Date.now() + HOUR),
      batchSize: 10,
      deliver: (record) => publisher.publish(record),
      retryAt: () => new Date(Date.now() + HOUR),
    });

  const spanNamed = (name: string): ReadableSpan | undefined =>
    probe.spans().find((span) => span.name === name);

  it("puts the request, the publish and the consume in one trace", async () => {
    await trace.getTracer("spec").startActiveSpan("POST /v1/users", async (request) => {
      await transactions.run((tx) => outbox.stage(tx, "user.registered", { ...payload }));
      request.end();
    });

    await relay();
    await waitFor(() => delivered.length === 1);

    // The consumer, in what is a different process in production: it knows
    // nothing but the bytes and the headers it was handed.
    const message = delivered[0]!;
    context.with(extractTraceContext(message.headers), () => {
      trace.getTracer("spec").startActiveSpan("domain-events process", (span) => span.end());
    });

    const request = spanNamed("POST /v1/users");
    const publish = spanNamed(`${TOPIC} send`);
    const consume = spanNamed(`${TOPIC} process`);

    expect(request).toBeDefined();
    expect(publish).toBeDefined();
    expect(consume).toBeDefined();

    // One trace, three spans, in a chain.
    expect(publish?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(consume?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(publish?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(consume?.parentSpanContext?.spanId).toBe(publish?.spanContext().spanId);
  });

  /**
   * The regression this whole design is guarding against, stated as an
   * assertion: had the publisher used the ambient context, the publish span
   * would be a root span in a trace of its own, and the request that caused the
   * event would be unreachable from the message.
   */
  it("parents the publish on the staging request, not on the drain that claimed the row", async () => {
    await trace.getTracer("spec").startActiveSpan("POST /v1/users", async (request) => {
      await transactions.run((tx) => outbox.stage(tx, "user.registered", { ...payload }));
      request.end();
    });

    // `relay()` runs here, at the top level, with no active span — exactly as
    // the poller does. A publish span with no parent would prove the row's
    // stored context was never read.
    await relay();

    expect(spanNamed(`${TOPIC} send`)?.parentSpanContext).toBeDefined();
  });

  it("writes the producer span's own context to the wire, under the W3C header name", async () => {
    await transactions.run((tx) => outbox.stage(tx, "user.registered", { ...payload }));

    await relay();
    await waitFor(() => delivered.length === 1);

    const traceparent = delivered[0]!.headers[TRACEPARENT_HEADER];
    const publish = spanNamed(`${TOPIC} send`)!;
    expect(traceparent).toBe(
      `00-${publish.spanContext().traceId}-${publish.spanContext().spanId}-01`,
    );
  });

  it("carries the event's identity and its trace side by side", async () => {
    await transactions.run((tx) => outbox.stage(tx, "user.registered", { ...payload }));
    await relay();
    await waitFor(() => delivered.length === 1);

    const publish = spanNamed(`${TOPIC} send`)!;
    expect(publish.attributes["messaging.message.id"]).toBe(delivered[0]!.headers["event-id"]);
    expect(publish.attributes["app.event.name"]).toBe("user.registered");
    expect(publish.attributes["messaging.destination.name"]).toBe(TOPIC);
  });

  /**
   * Rows staged before the columns existed, and rows staged while telemetry was
   * off, are both perfectly ordinary. Publishing one starts a new trace rather
   * than failing or inventing a parent.
   */
  it("starts a fresh trace for a row with no stored context", async () => {
    await transactions.run((tx) =>
      store.stage(tx, {
        eventId: "11111111-1111-4111-8111-111111111111",
        name: "user.registered",
        payload: { ...payload },
        correlationId: null,
        trace: { traceparent: null, tracestate: null },
        occurredAt: new Date(),
      }),
    );

    await relay();

    const publish = spanNamed(`${TOPIC} send`);
    expect(publish).toBeDefined();
    expect(publish?.parentSpanContext).toBeUndefined();
  });

  it("records the failure on the publish span when the broker refuses", async () => {
    await transactions.run((tx) => outbox.stage(tx, "user.registered", { ...payload }));
    await broker.disconnect();

    await expect(relay()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ disposition: "retry" })],
    });

    const publish = spanNamed(`${TOPIC} send`);
    // ERROR, and with the exception attached: a backend counts the status and
    // an engineer reads the event.
    expect(publish?.status.code).toBe(2);
    expect(publish?.events.map((event) => event.name)).toContain("exception");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}
