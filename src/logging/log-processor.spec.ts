import { REDACTED, type LogEvent } from "./log-event";
import { runProcessors, type LogProcessor } from "./log-processor";

const event: LogEvent = {
  level: "log",
  message: "placed an order",
  context: "OrdersController",
  fields: { userId: "u-1", customerEmail: "ada@example.com" },
};

describe("runProcessors", () => {
  it("threads the event through the chain in order", () => {
    const seen: string[] = [];
    const tag =
      (name: string): LogProcessor =>
      (e) => {
        seen.push(name);
        return { ...e, message: `${e.message}|${name}` };
      };
    const result = runProcessors([tag("one"), tag("two")], event);
    expect(seen).toEqual(["one", "two"]);
    expect(result?.message).toBe("placed an order|one|two");
  });

  it("returns the event unchanged through an empty chain", () => {
    expect(runProcessors([], event)).toBe(event);
  });

  describe("dropping", () => {
    it("returns null when a processor drops the record", () => {
      expect(runProcessors([() => null], event)).toBeNull();
    });

    it("does not run processors after the one that dropped", () => {
      const after = jest.fn<LogEvent | null, [LogEvent]>((e) => e);
      runProcessors([() => null, after], event);
      expect(after).not.toHaveBeenCalled();
    });
  });

  describe("failing closed", () => {
    const throwing: LogProcessor = () => {
      throw new TypeError("cannot read properties of undefined");
    };

    /**
     * The direction of this failure is the whole design. A processor that threw
     * has not finished deciding what was safe, so emitting the original would
     * make the redactor's own bug the disclosure — on the record that was
     * unusual enough to break it, which is disproportionately the interesting
     * one.
     */
    it("does not emit the original content when a processor throws", () => {
      const result = runProcessors([throwing], event);
      expect(JSON.stringify(result)).not.toContain("ada@example.com");
      expect(JSON.stringify(result)).not.toContain("placed an order");
    });

    /**
     * And it does not emit nothing either. A redactor throwing on every record
     * would otherwise present as a service that had stopped logging, with the
     * cause invisible precisely because the evidence is what is missing.
     */
    it("emits a substitute record rather than dropping the line", () => {
      const result = runProcessors([throwing], event);
      expect(result).not.toBeNull();
      expect(result?.message).toContain("log redaction failed");
      expect(result?.fields["redactionFailed"]).toBe(true);
    });

    it("raises the level to error and records the original level", () => {
      const result = runProcessors([throwing], event);
      expect(result?.level).toBe("error");
      expect(result?.fields["originalLevel"]).toBe("log");
    });

    it("names the error's type, which is a programmer's word and findable", () => {
      expect(runProcessors([throwing], event)?.message).toContain("TypeError");
    });

    /**
     * `error.message` is deliberately absent: a thrown message routinely quotes
     * the value that caused it, which here is the value being redacted.
     */
    it("does not include the thrown error's message", () => {
      const result = runProcessors([throwing], event);
      expect(result?.message).not.toContain("cannot read properties of undefined");
    });

    it("keeps the context, which names a class rather than carrying data", () => {
      expect(runProcessors([throwing], event)?.context).toBe("OrdersController");
    });

    /**
     * A chain that fails at step two must not emit what step one produced.
     * Those are intermediate states, and if the redacting processor has not run
     * yet the intermediate *is* the raw record.
     */
    it("does not emit a partially processed record", () => {
      const enrich: LogProcessor = (e) => ({
        ...e,
        fields: { ...e.fields, tenant: "acme", cardNumber: "4111111111111111" },
      });
      const result = runProcessors([enrich, throwing], event);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain("4111111111111111");
      expect(rendered).not.toContain("acme");
      expect(result?.fields["message"]).toBe(REDACTED);
    });

    it("reports the failure to the caller so a broken chain is visible", () => {
      const onFailure = jest.fn();
      runProcessors([throwing], event, onFailure);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
    });

    it("survives a processor that throws a non-Error", () => {
      const result = runProcessors(
        [
          () => {
            throw "a string";
          },
        ],
        event,
      );
      expect(result?.message).toContain("string");
      expect(result?.fields["redactionFailed"]).toBe(true);
    });
  });
});
