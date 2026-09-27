import { toLogEvent } from "./to-log-event";

describe("toLogEvent", () => {
  describe("the string call, which is almost every call site", () => {
    it("reads a bare message", () => {
      expect(toLogEvent("log", "relay drained", [])).toEqual({
        level: "log",
        message: "relay drained",
        context: undefined,
        fields: {},
      });
    });

    /**
     * Nest passes the logger's context as the last argument. Left in the body it
     * turns every record into `"message,OutboxRelay"`, which is neither the
     * message nor a field anything can group by.
     */
    it("lifts a trailing string out as the context", () => {
      const event = toLogEvent("log", "relay drained", ["OutboxRelay"]);
      expect(event.context).toBe("OutboxRelay");
      expect(event.message).toBe("relay drained");
      expect(event.fields).toEqual({});
    });

    it("puts an extra positional argument in a field, where the allowlist can see it", () => {
      const event = toLogEvent("log", "m", [{ email: "ada@example.com" }, "Ctx"]);
      expect(event.context).toBe("Ctx");
      expect(event.fields["extra"]).toEqual([{ email: "ada@example.com" }]);
    });
  });

  describe("the structured call", () => {
    it("reads a plain object as the fields and lifts its message out", () => {
      const event = toLogEvent(
        "log",
        { message: "request", statusCode: 200, path: "/v1/users" },
        [],
      );
      expect(event.message).toBe("request");
      expect(event.fields).toEqual({ statusCode: 200, path: "/v1/users" });
    });

    it("leaves the message empty when the object has none", () => {
      const event = toLogEvent("log", { statusCode: 200 }, []);
      expect(event.message).toBe("");
      expect(event.fields).toEqual({ statusCode: 200 });
    });

    it("does not treat a non-string message key as the message", () => {
      const event = toLogEvent("log", { message: 42 }, []);
      expect(event.message).toBe("");
    });

    it("keeps a context passed alongside a structured call", () => {
      const event = toLogEvent("log", { message: "request" }, ["HTTP"]);
      expect(event.context).toBe("HTTP");
    });
  });

  describe("errors", () => {
    /**
     * Split rather than joined, because the halves have different exposures: the
     * class name is a programmer's word and belongs in a field, while the
     * message quotes whatever caused the failure and cannot be trusted.
     */
    it("splits an Error into a typed field and a message", () => {
      const event = toLogEvent("error", new RangeError("page 500 is out of range"), []);
      expect(event.message).toBe("page 500 is out of range");
      expect(event.fields["errorType"]).toBe("RangeError");
      expect(event.fields["stack"]).toContain("RangeError");
    });

    it("names a subclass by its own constructor", () => {
      class PaymentDeclinedError extends Error {}
      const event = toLogEvent("error", new PaymentDeclinedError("declined"), []);
      expect(event.fields["errorType"]).toBe("PaymentDeclinedError");
    });

    it("puts the stack in a field, so it is redacted unless allowlisted", () => {
      const event = toLogEvent("error", new Error("boom"), []);
      expect(Object.keys(event.fields)).toContain("stack");
      expect(event.message).not.toContain("at ");
    });
  });

  describe("shapes that are nobody's intent", () => {
    /**
     * `String(value)` on an arbitrary object runs a `toString` this module does
     * not own, on an object that may be holding the data being redacted:
     * `[object Object]` at best and the whole entity at worst.
     */
    it("names a class instance by type and moves it into a field", () => {
      class Customer {
        constructor(readonly email: string) {}
      }
      const event = toLogEvent("log", new Customer("ada@example.com"), []);
      expect(event.message).toBe("<Customer>");
      expect(event.fields["messageObject"]).toBeInstanceOf(Customer);
    });

    it.each([
      [42, "42"],
      [true, "true"],
      [7n, "7"],
      [null, ""],
      [undefined, ""],
    ])("renders the primitive %p as %p", (message, expected) => {
      expect(toLogEvent("log", message, []).message).toBe(expected);
    });

    it("renders a symbol without throwing, which String() would", () => {
      expect(toLogEvent("log", Symbol("tag"), []).message).toBe("Symbol(tag)");
    });

    it("moves an array in the message slot into a field", () => {
      const event = toLogEvent("log", ["a", "b"], []);
      expect(event.fields["messageObject"]).toEqual(["a", "b"]);
    });
  });
});
