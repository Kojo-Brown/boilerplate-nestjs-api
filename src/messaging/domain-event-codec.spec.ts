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
import { UndecodableMessageError } from "./messaging.errors";

const TOPIC = "domain-events";

const registered: EncodedDomainEvent = {
  name: "user.registered",
  payload: { userId: "user-1", email: "ada@example.test", name: "Ada", provider: null },
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: new Date("2026-08-27T00:00:00.000Z"),
  correlationId: "req-7",
};

/** An `IncomingMessage` built from what `encodeDomainEvent` produced. */
function roundTrip(event: EncodedDomainEvent, overrides: Partial<IncomingMessage> = {}) {
  const outgoing = encodeDomainEvent(TOPIC, event);
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
    const message = encodeDomainEvent(TOPIC, registered);

    expect(message.topic).toBe(TOPIC);
    expect(message.key).toBe("user-1");
    expect(message.headers).toEqual({
      [EVENT_HEADERS.name]: "user.registered",
      [EVENT_HEADERS.id]: registered.eventId,
      [EVENT_HEADERS.occurredAt]: "2026-08-27T00:00:00.000Z",
      [EVENT_HEADERS.correlationId]: "req-7",
      [EVENT_HEADERS.contentType]: EVENT_CONTENT_TYPE,
    });
    expect(JSON.parse(message.value.toString("utf8"))).toEqual(registered.payload);
  });

  it("omits the correlation header rather than sending it empty", () => {
    // An absent header and a header whose value is "" are different things on
    // the wire, and `null` has no spelling in a bytes-to-bytes map.
    const message = encodeDomainEvent(TOPIC, { ...registered, correlationId: null });
    expect(EVENT_HEADERS.correlationId in message.headers).toBe(false);
  });
});

describe("decodeDomainEvent", () => {
  it("round-trips an encoded event", () => {
    const decoded = decodeDomainEvent(roundTrip(registered));

    expect(decoded.name).toBe("user.registered");
    expect(decoded.payload).toEqual(registered.payload);
    expect(decoded.eventId).toBe(registered.eventId);
    expect(decoded.occurredAt).toEqual(registered.occurredAt);
    expect(decoded.correlationId).toBe("req-7");
  });

  it("reads a missing correlation header back as null", () => {
    const decoded = decodeDomainEvent(roundTrip({ ...registered, correlationId: null }));
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

    expect(() => decodeDomainEvent({ ...message, headers })).toThrow(UndecodableMessageError);
  });

  it.each([
    ["is not JSON", "}{"],
    ["is a JSON scalar", '"a string"'],
    ["is a JSON array", "[1, 2]"],
    ["is JSON null", "null"],
  ])("rejects a message whose value %s", (_description, body) => {
    const message = roundTrip(registered);
    expect(() => decodeDomainEvent({ ...message, value: Buffer.from(body, "utf8") })).toThrow(
      UndecodableMessageError,
    );
  });

  it("names the coordinates of the message it could not read", () => {
    const message = roundTrip(registered, { topic: "t", partition: 4, offset: "912" });
    const headers = { ...message.headers };
    delete headers[EVENT_HEADERS.name];

    // The message is the only handle an operator has on a record that has been
    // committed past, so the topic, partition and offset have to be in it.
    expect(() => decodeDomainEvent({ ...message, headers })).toThrow(/t\/4@912/);
  });
});
