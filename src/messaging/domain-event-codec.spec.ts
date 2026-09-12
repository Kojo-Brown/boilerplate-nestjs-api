import type { IncomingMessage } from "./ports";
import { nextOffset } from "./ports";
import {
  EVENT_CONTENT_TYPE,
  EVENT_HEADERS,
  decodeDomainEvent,
  encodeDomainEvent,
  partitionKeyFor,
  type EncodedDomainEvent,
} from "./domain-event-codec";
import { trace } from "@opentelemetry/api";
import { SchemaValidationError } from "@/schema-registry";
import { TRACEPARENT_HEADER, TRACESTATE_HEADER } from "@/telemetry";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
import { realEventContract } from "@/test-utils/event-contract";
import { SchemaContractViolationError, UndecodableMessageError } from "./messaging.errors";

const TOPIC = "domain-events";

/** The real catalogue: every encode and decode below goes through its contracts. */
const contract = realEventContract();

const registered: EncodedDomainEvent = {
  name: "user.registered",
  payload: { userId: "user-1", email: "ada@example.test", name: "Ada", provider: null },
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: new Date("2026-08-27T00:00:00.000Z"),
  correlationId: "req-7",
};

/** An `IncomingMessage` built from what `encodeDomainEvent` produced. */
function roundTrip(event: EncodedDomainEvent, overrides: Partial<IncomingMessage> = {}) {
  const outgoing = encodeDomainEvent(TOPIC, event, contract);
  return {
    topic: outgoing.topic,
    partition: 0,
    offset: "0",
    key: outgoing.key,
    value: outgoing.value,
    headers: outgoing.headers,
    timestamp: new Date(),
    ...overrides,
  } satisfies IncomingMessage;
}

describe("nextOffset", () => {
  it("returns the offset after the one handled", () => {
    expect(nextOffset("0")).toBe("1");
    expect(nextOffset("41")).toBe("42");
  });

  it("does not lose precision past Number.MAX_SAFE_INTEGER", () => {
    // Kafka offsets are int64. The naive `String(Number(offset) + 1)` returns
    // "9007199254740992" here — the same value it was given — so a partition
    // that has carried this many messages would replay its last one forever.
    const beyond = "9007199254740993";
    expect(nextOffset(beyond)).toBe("9007199254740994");
    expect(Number.isSafeInteger(Number(beyond))).toBe(false);
  });
});

describe("partitionKeyFor", () => {
  it("keys every event on the user it is about", () => {
    expect(partitionKeyFor(registered)).toBe("user-1");
    expect(
      partitionKeyFor({ name: "user.deleted", payload: { userId: "u2", email: "b@example.test" } }),
    ).toBe("u2");
  });

  it("gives two events about one user the same key, so they stay ordered", () => {
    const created = partitionKeyFor(registered);
    const deleted = partitionKeyFor({
      name: "user.deleted",
      payload: { userId: "user-1", email: "ada@example.test" },
    });
    expect(created).toBe(deleted);
  });
});

describe("encodeDomainEvent", () => {
  it("puts metadata in headers and the payload in the value", () => {
    const message = encodeDomainEvent(TOPIC, registered, contract);

    expect(message.topic).toBe(TOPIC);
    expect(message.key).toBe("user-1");
    expect(message.headers).toEqual({
      [EVENT_HEADERS.name]: "user.registered",
      [EVENT_HEADERS.id]: registered.eventId,
      [EVENT_HEADERS.occurredAt]: "2026-08-27T00:00:00.000Z",
      [EVENT_HEADERS.correlationId]: "req-7",
      [EVENT_HEADERS.contentType]: EVENT_CONTENT_TYPE,
      [EVENT_HEADERS.schemaVersion]: "1",
    });
    expect(JSON.parse(message.value.toString("utf8"))).toEqual(registered.payload);
  });

  it("stamps the version of the schema that validated the payload", () => {
    const message = encodeDomainEvent(TOPIC, registered, contract);
    expect(message.headers[EVENT_HEADERS.schemaVersion]).toBe(
      contract.readerVersion("user.registered").toString(),
    );
  });

  it("refuses to encode a payload that violates its own contract", () => {
    // A producer must not be able to put bytes on a topic that its own
    // consumers are then obliged to dead-letter. The relay treats this like a
    // broker rejection: the row stays unpublished and is retried, so a deploy
    // can fix it and the event is still there.
    expect(() =>
      encodeDomainEvent(
        TOPIC,
        { ...registered, payload: { ...registered.payload, userId: 7 } } as never,
        contract,
      ),
    ).toThrow(SchemaValidationError);
  });

  it("omits the correlation header rather than sending it empty", () => {
    // An absent header and a header whose value is "" are different things on
    // the wire, and `null` has no spelling in a bytes-to-bytes map.
    const message = encodeDomainEvent(TOPIC, { ...registered, correlationId: null }, contract);
    expect(EVENT_HEADERS.correlationId in message.headers).toBe(false);
  });
});

describe("decodeDomainEvent", () => {
  it("round-trips an encoded event", () => {
    const decoded = decodeDomainEvent(roundTrip(registered), contract);

    expect(decoded.name).toBe("user.registered");
    expect(decoded.payload).toEqual(registered.payload);
    expect(decoded.eventId).toBe(registered.eventId);
    expect(decoded.occurredAt).toEqual(registered.occurredAt);
    expect(decoded.correlationId).toBe("req-7");
  });

  it("reads a missing correlation header back as null", () => {
    const decoded = decodeDomainEvent(roundTrip({ ...registered, correlationId: null }), contract);
    expect(decoded.correlationId).toBeNull();
  });

  it.each([
    ["no event-name header", { [EVENT_HEADERS.name]: undefined }],
    ["an event this build does not know", { [EVENT_HEADERS.name]: "user.renamed" }],
    ["no event-id header", { [EVENT_HEADERS.id]: undefined }],
    ["an empty event-id", { [EVENT_HEADERS.id]: "" }],
    ["no occurred-at header", { [EVENT_HEADERS.occurredAt]: undefined }],
    ["an unparseable occurred-at", { [EVENT_HEADERS.occurredAt]: "not-a-date" }],
  ])("rejects a message with %s", (_description, patch) => {
    const message = roundTrip(registered);
    const headers: Record<string, string> = { ...message.headers };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }

    expect(() => decodeDomainEvent({ ...message, headers }, contract)).toThrow(
      UndecodableMessageError,
    );
  });

  it.each([
    ["is not JSON", "}{"],
    ["is a JSON scalar", '"a string"'],
    ["is a JSON array", "[1, 2]"],
    ["is JSON null", "null"],
  ])("rejects a message whose value %s", (_description, body) => {
    const message = roundTrip(registered);
    expect(() =>
      decodeDomainEvent({ ...message, value: Buffer.from(body, "utf8") }, contract),
    ).toThrow(UndecodableMessageError);
  });

  it("names the coordinates of the message it could not read", () => {
    const message = roundTrip(registered, { topic: "t", partition: 4, offset: "912" });
    const headers = { ...message.headers };
    delete headers[EVENT_HEADERS.name];

    // The message is the only handle an operator has on a record that has been
    // committed past, so the topic, partition and offset have to be in it.
    expect(() => decodeDomainEvent({ ...message, headers }, contract)).toThrow(/t\/4@912/);
  });

  describe("the schema contract", () => {
    /** A message whose headers are ours and whose body is whatever is passed. */
    function withPayload(payload: unknown): IncomingMessage {
      const message = roundTrip(registered);
      return { ...message, value: Buffer.from(JSON.stringify(payload), "utf8") };
    }

    it("rejects a payload that does not match the schema for its event", () => {
      expect(() => decodeDomainEvent(withPayload({ userId: "u1" }), contract)).toThrow(
        SchemaContractViolationError,
      );
    });

    it("keeps a contract violation apart from an undecodable message", () => {
      // Both skip the retry ladder and both end on the dead-letter topic, but
      // they belong to different owners: "stop that system writing to our
      // topic" and "that service skipped a schema version" are different pages.
      const violation = (() => {
        try {
          decodeDomainEvent(withPayload({ userId: "u1" }), contract);
        } catch (caught: unknown) {
          return caught;
        }
        throw new Error("expected a rejection");
      })();

      expect(violation).toBeInstanceOf(SchemaContractViolationError);
      expect(violation).not.toBeInstanceOf(UndecodableMessageError);
    });

    it("reports the writer's version and the reader's", () => {
      let thrown: SchemaContractViolationError | undefined;
      try {
        decodeDomainEvent(withPayload({ userId: "u1" }), contract);
      } catch (caught: unknown) {
        thrown = caught as SchemaContractViolationError;
      }

      expect(thrown!.subject).toBe("user.registered");
      expect(thrown!.writerVersion).toBe(1);
      expect(thrown!.readerVersion).toBe(contract.readerVersion("user.registered"));
      expect(thrown!.message).toMatch(/written by v1, rejected by v1/);
    });

    it("reads the writer's schema version back off the wire", () => {
      const decoded = decodeDomainEvent(roundTrip(registered), contract);
      expect(decoded.writerSchemaVersion).toBe(1);
    });

    it("tolerates a message written before the version header existed", () => {
      // The deploy that introduces schema validation finds a topic full of
      // messages no producer stamped. Rejecting those would dead-letter the
      // entire retained log on upgrade — the registry's first act would be to
      // destroy the history it exists to keep readable.
      const message = roundTrip(registered);
      const headers = { ...message.headers };
      delete headers[EVENT_HEADERS.schemaVersion];

      const decoded = decodeDomainEvent({ ...message, headers }, contract);
      expect(decoded.writerSchemaVersion).toBeNull();
      expect(decoded.payload).toEqual(registered.payload);
    });

    it.each(["", "v2", "0", "1.5"])(
      "rejects a version header that is present and not a version: %p",
      (value) => {
        // Absent means "written before this existed". Present and unparseable
        // means a producer is writing something this format does not define,
        // and guessing what it meant is how a decoder trusts a number it
        // invented.
        const message = roundTrip(registered);
        const headers = { ...message.headers, [EVENT_HEADERS.schemaVersion]: value };
        expect(() => decodeDomainEvent({ ...message, headers }, contract)).toThrow(
          UndecodableMessageError,
        );
      },
    );

    it("accepts a writer version newer than anything this build knows", () => {
      // What FULL_TRANSITIVE compatibility buys: a consumer mid-rollout reads
      // messages from producers ahead of it, and validates them against its own
      // schema rather than fetching one it has never seen.
      const message = roundTrip(registered);
      const headers = { ...message.headers, [EVENT_HEADERS.schemaVersion]: "99" };

      const decoded = decodeDomainEvent({ ...message, headers }, contract);
      expect(decoded.writerSchemaVersion).toBe(99);
      expect(decoded.payload).toEqual(registered.payload);
    });

    it("accepts a payload carrying a field this build has never heard of", () => {
      // The open content model on the real path. A producer must be able to add
      // an optional field and roll out ahead of its consumers.
      const decoded = decodeDomainEvent(
        withPayload({ ...registered.payload, locale: "en-GB" }),
        contract,
      );
      expect(decoded.payload).toEqual({ ...registered.payload, locale: "en-GB" });
    });
  });

  describe("trace context", () => {
    /**
     * The header carries no `event-` prefix, unlike everything else this codec
     * writes, because unlike everything else it is not this repository's
     * invention: a consumer in another language, with an SDK that has never
     * heard of this service, finds its parent by looking for exactly this key.
     */
    describe("with an SDK installed", () => {
      let probe: TelemetryProbe;

      beforeEach(() => {
        probe = installInMemoryTelemetry();
      });

      afterEach(async () => {
        await probe.shutdown();
      });

      it("writes the active span's traceparent", () => {
        const message = trace.getTracer("spec").startActiveSpan("publish", (span) => {
          try {
            return encodeDomainEvent(TOPIC, registered, contract);
          } finally {
            span.end();
          }
        });

        const published = probe.spans()[0]!.spanContext();
        expect(message.headers[TRACEPARENT_HEADER]).toBe(
          `00-${published.traceId}-${published.spanId}-01`,
        );
      });

      it("leaves the event's own headers alone", () => {
        const message = trace.getTracer("spec").startActiveSpan("publish", (span) => {
          try {
            return encodeDomainEvent(TOPIC, registered, contract);
          } finally {
            span.end();
          }
        });

        expect(message.headers[EVENT_HEADERS.name]).toBe("user.registered");
        expect(message.headers[EVENT_HEADERS.id]).toBe(registered.eventId);
        expect(message.headers[EVENT_HEADERS.contentType]).toBe(EVENT_CONTENT_TYPE);
      });
    });

    /**
     * No trace, no header — rather than a header describing a span that does
     * not exist. A consumer that extracted one would start a child of nothing
     * and report a trace whose root is missing.
     */
    it("writes no trace headers when nothing is being traced", () => {
      const message = encodeDomainEvent(TOPIC, registered, contract);

      expect(message.headers[TRACEPARENT_HEADER]).toBeUndefined();
      expect(message.headers[TRACESTATE_HEADER]).toBeUndefined();
    });
  });
});
