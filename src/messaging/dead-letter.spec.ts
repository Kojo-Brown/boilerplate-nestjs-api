import {
  DEAD_LETTER_HEADERS,
  defaultDeadLetterTopic,
  describeError,
  toDeadLetterMessage,
  type DeadLetterContext,
} from "./dead-letter";
import { EVENT_HEADERS } from "./domain-event-codec";
import type { IncomingMessage } from "./ports";

const message: IncomingMessage = {
  topic: "domain-events",
  partition: 2,
  offset: "9007199254740993",
  key: "user-1",
  value: Buffer.from('{"userId":"user-1"}', "utf8"),
  headers: {
    [EVENT_HEADERS.name]: "user.registered",
    [EVENT_HEADERS.id]: "44444444-4444-4444-8444-444444444444",
    [EVENT_HEADERS.correlationId]: "req-3",
  },
  timestamp: new Date("2026-08-27T10:00:00.000Z"),
};

const context: DeadLetterContext = {
  groupId: "spec-group",
  reason: "handler-failed",
  attempts: 4,
  error: new TypeError("cannot read properties of undefined"),
  failedAt: new Date("2026-08-27T10:00:05.000Z"),
};

describe("toDeadLetterMessage", () => {
  it("copies the value byte for byte", () => {
    const dead = toDeadLetterMessage("domain-events.dlt", message, context);

    // Identity, not just equality. Re-encoding would defeat the point for an
    // undecodable message, where the bytes are the only evidence of what went
    // wrong and this build has already proven it cannot parse them.
    expect(dead.value).toBe(message.value);
    expect(dead.topic).toBe("domain-events.dlt");
  });

  it("keeps the partition key, so the dead-letter topic orders by aggregate too", () => {
    expect(toDeadLetterMessage("domain-events.dlt", message, context).key).toBe("user-1");
  });

  it("keeps the producer's own headers alongside the dlt ones", () => {
    const dead = toDeadLetterMessage("domain-events.dlt", message, context);

    // `event-id` and `correlation-id` are how a dead letter is traced back to
    // the request that produced it; losing them would leave an operator with a
    // failure and no way to find its cause.
    expect(dead.headers[EVENT_HEADERS.id]).toBe("44444444-4444-4444-8444-444444444444");
    expect(dead.headers[EVENT_HEADERS.correlationId]).toBe("req-3");
    expect(dead.headers[EVENT_HEADERS.name]).toBe("user.registered");
  });

  it("records what failed, why, and where the original is", () => {
    const dead = toDeadLetterMessage("domain-events.dlt", message, context);

    expect(dead.headers[DEAD_LETTER_HEADERS.reason]).toBe("handler-failed");
    expect(dead.headers[DEAD_LETTER_HEADERS.error]).toBe("cannot read properties of undefined");
    expect(dead.headers[DEAD_LETTER_HEADERS.errorType]).toBe("TypeError");
    expect(dead.headers[DEAD_LETTER_HEADERS.attempts]).toBe("4");
    expect(dead.headers[DEAD_LETTER_HEADERS.group]).toBe("spec-group");
    expect(dead.headers[DEAD_LETTER_HEADERS.originTopic]).toBe("domain-events");
    expect(dead.headers[DEAD_LETTER_HEADERS.originPartition]).toBe("2");
    expect(dead.headers[DEAD_LETTER_HEADERS.failedAt]).toBe("2026-08-27T10:00:05.000Z");
  });

  it("carries the offset as the string it arrived as", () => {
    // Past `Number.MAX_SAFE_INTEGER`, which an offset on a busy partition
    // reaches. Anything that routed this through a `number` would hand an
    // operator coordinates that point at the wrong record — or at no record.
    expect(
      toDeadLetterMessage("domain-events.dlt", message, context).headers[
        DEAD_LETTER_HEADERS.originOffset
      ],
    ).toBe("9007199254740993");
  });

  it("truncates an error too large to send as a header", () => {
    const dead = toDeadLetterMessage("domain-events.dlt", message, {
      ...context,
      error: new Error("x".repeat(5_000)),
    });

    // Kafka counts headers against `message.max.bytes`, so an unbounded stack
    // trace or a driver error quoting a whole statement could make the record
    // that reports a failure fail to produce — losing the message the topic
    // exists to keep.
    const reported = dead.headers[DEAD_LETTER_HEADERS.error] ?? "";
    expect(reported.length).toBe(500);
    expect(reported.endsWith("…")).toBe(true);
  });

  it("describes a thrown non-Error rather than sending `[object Object]` headers", () => {
    const dead = toDeadLetterMessage("domain-events.dlt", message, {
      ...context,
      error: "a string nobody wrapped",
    });

    expect(dead.headers[DEAD_LETTER_HEADERS.error]).toBe("a string nobody wrapped");
    expect(dead.headers[DEAD_LETTER_HEADERS.errorType]).toBe("string");
  });

  it("overwrites the dlt headers of a message that was redriven and failed again", () => {
    const redriven: IncomingMessage = {
      ...message,
      topic: "domain-events",
      partition: 1,
      offset: "77",
      headers: {
        ...message.headers,
        [DEAD_LETTER_HEADERS.attempts]: "4",
        [DEAD_LETTER_HEADERS.originTopic]: "domain-events",
        [DEAD_LETTER_HEADERS.originOffset]: "12",
      },
    };

    const dead = toDeadLetterMessage("domain-events.dlt", redriven, { ...context, attempts: 2 });

    // Not accumulated: the header set always describes the most recent failure,
    // and the origin coordinates always point at the record that would be
    // redriven next rather than at one that was already replayed.
    expect(dead.headers[DEAD_LETTER_HEADERS.attempts]).toBe("2");
    expect(dead.headers[DEAD_LETTER_HEADERS.originOffset]).toBe("77");
    expect(dead.headers[DEAD_LETTER_HEADERS.originPartition]).toBe("1");
  });
});

describe("defaultDeadLetterTopic", () => {
  it("derives from the source topic, so renaming one moves the other", () => {
    expect(defaultDeadLetterTopic("domain-events")).toBe("domain-events.dlt");
    expect(defaultDeadLetterTopic("acme.orders")).toBe("acme.orders.dlt");
  });

  it("never collides with the topic it is derived from", () => {
    // The check `env.schema.ts` makes for an explicitly configured topic is
    // unreachable for a derived one, and this is why.
    for (const topic of ["domain-events", "a", "x.dlt"]) {
      expect(defaultDeadLetterTopic(topic)).not.toBe(topic);
    }
  });
});

describe("describeError", () => {
  it("prefers the message and falls back to the value", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
  });
});
