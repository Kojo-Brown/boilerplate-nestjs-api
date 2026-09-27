import { REDACTED, TRUNCATED, type LogEvent } from "./log-event";
import { MAX_DEPTH, MAX_NODES, redactFields } from "./redact-fields";
import { compileAllowlist } from "./redaction-allowlist";

function redact(fields: Record<string, unknown>, patterns: readonly string[]): LogEvent["fields"] {
  const { allowlist } = compileAllowlist(patterns);
  const processed = redactFields(allowlist)({
    level: "log",
    message: "m",
    fields,
  });
  return processed === null ? {} : processed.fields;
}

describe("redactFields", () => {
  describe("the allowlist decides", () => {
    it("keeps an allowlisted value", () => {
      expect(redact({ userId: "u-1" }, ["userId"])).toEqual({ userId: "u-1" });
    });

    it("redacts a field nobody allowlisted", () => {
      expect(redact({ customerEmail: "ada@example.com" }, ["userId"])).toEqual({
        customerEmail: REDACTED,
      });
    });

    /**
     * The failure mode this design exists to prevent. A denylist of known-bad
     * key names admits every spelling nobody thought of; an allowlist admits
     * none of them, so the field that leaks is the field somebody chose to
     * expose in a diff.
     */
    it.each([
      "email",
      "emailAddress",
      "e_mail",
      "userEmail",
      "contactEmail",
      "dateOfBirth",
      "dob",
      "nationalInsuranceNumber",
      "taxId",
      "homeAddress",
      "phone",
      "cardNumber",
    ])("redacts %s without having been told about it", (key) => {
      expect(redact({ [key]: "value" }, ["userId"])).toEqual({ [key]: REDACTED });
    });

    it("keeps the key, so an operator can see the field exists", () => {
      const redacted = redact({ customerEmail: "ada@example.com" }, []);
      expect(Object.keys(redacted)).toEqual(["customerEmail"]);
    });
  });

  describe("types", () => {
    /**
     * Redaction is decided by path, never by type. A number is a salary or a
     * date of birth; a boolean is one bit that can still be a diagnosis.
     */
    it.each([
      ["a number", 82_500],
      ["a boolean", true],
      ["a bigint", 10n],
    ])("redacts %s that is not allowlisted", (_label, value) => {
      expect(redact({ salary: value }, [])).toEqual({ salary: REDACTED });
    });

    it("keeps an allowlisted number and boolean as themselves", () => {
      expect(redact({ statusCode: 200, cached: true }, ["statusCode", "cached"])).toEqual({
        statusCode: 200,
        cached: true,
      });
    });

    it("renders an allowlisted bigint as a string, since JSON has no bigint", () => {
      expect(redact({ offset: 9_007_199_254_740_993n }, ["offset"])).toEqual({
        offset: "9007199254740993",
      });
    });

    it("renders an allowlisted Date in ISO form", () => {
      expect(redact({ at: new Date("2026-07-27T10:00:00.000Z") }, ["at"])).toEqual({
        at: "2026-07-27T10:00:00.000Z",
      });
    });

    /**
     * `null` is the absence of data, so there is nothing to disclose — and the
     * difference between "the field was not set" and "the field was set and you
     * may not see it" is one an operator needs on every line.
     */
    it("passes null and undefined through unredacted", () => {
      expect(redact({ userId: null, trace_id: undefined }, [])).toEqual({
        userId: null,
        trace_id: undefined,
      });
    });

    /**
     * A class instance is admitted or redacted whole, never walked. Walking one
     * means reading its getters, which is somebody else's code running inside
     * the logging path — where it may throw, may be slow, and may lazily fetch
     * the thing being redacted.
     */
    it("redacts a class instance even where its path is allowlisted", () => {
      class Customer {
        constructor(readonly email: string) {}
      }
      expect(redact({ customer: new Customer("ada@example.com") }, ["customer"])).toEqual({
        customer: REDACTED,
      });
    });

    it("walks an object with a null prototype", () => {
      const bare = Object.create(null) as Record<string, unknown>;
      bare["id"] = "keep";
      bare["secret"] = "drop";
      expect(redact({ meta: bare }, ["meta.id"])).toEqual({
        meta: { id: "keep", secret: REDACTED },
      });
    });
  });

  describe("structure", () => {
    it("preserves the shape and redacts only the leaves", () => {
      expect(
        redact({ order: { id: "o-1", total: 4999, note: "flat 3, Ada" } }, [
          "order.id",
          "order.total",
        ]),
      ).toEqual({ order: { id: "o-1", total: 4999, note: REDACTED } });
    });

    it("keeps an array's length so a count survives redaction", () => {
      const redacted = redact({ items: [{ sku: "A" }, { sku: "B" }, { sku: "C" }] }, []);
      expect(redacted["items"]).toEqual([{ sku: REDACTED }, { sku: REDACTED }, { sku: REDACTED }]);
    });

    /**
     * One decision per array, not one per index. An allowlist written against
     * indices would admit the first element and redact the rest, which looks
     * like data corruption and would be debugged as one.
     */
    it("applies one decision to every element of an array", () => {
      expect(redact({ items: [{ sku: "A" }, { sku: "B" }] }, ["items[].sku"])).toEqual({
        items: [{ sku: "A" }, { sku: "B" }],
      });
    });

    it("scrubs credentials out of an allowlisted string", () => {
      expect(redact({ path: "/cb?code=4/0AXsecret" }, ["path"])).toEqual({
        path: `/cb?code=${REDACTED}`,
      });
    });
  });

  describe("hostile shapes", () => {
    it("cuts a cycle instead of recursing forever", () => {
      const node: Record<string, unknown> = { id: "n-1" };
      node["self"] = node;
      expect(redact({ node }, ["node.id"])).toEqual({ node: { id: "n-1", self: TRUNCATED } });
    });

    /**
     * Only an ancestor is a cycle. A `seen` set that only grew would report the
     * second of two sibling fields holding one object as a cycle, and redact a
     * value it had just admitted.
     */
    it("does not mistake a shared object for a cycle", () => {
      const shared = { id: "s-1" };
      expect(redact({ left: shared, right: shared }, ["left.id", "right.id"])).toEqual({
        left: { id: "s-1" },
        right: { id: "s-1" },
      });
    });

    it("stops descending past the depth cap", () => {
      let deep: Record<string, unknown> = { bottom: "value" };
      for (let i = 0; i < MAX_DEPTH + 4; i += 1) deep = { next: deep };
      // Nothing throws, and nothing below the cap is rendered.
      expect(JSON.stringify(redact({ deep }, []))).toContain(TRUNCATED);
    });

    it("stops after the node cap and does not leak what is past it", () => {
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < MAX_NODES + 50; i += 1) wide[`k${i}`] = `secret-${i}`;
      const rendered = JSON.stringify(redact({ wide }, []));
      expect(rendered).toContain(TRUNCATED);
      expect(rendered).not.toContain("secret-");
    });

    /**
     * A caller who controls a key controls the rendered path: `{"a.b": …}` and a
     * nested `{a:{b:…}}` render identically and are not the same address. The
     * pattern `a.b` addresses the nested one, so the flat key is not admitted by
     * it — which is the safe direction, and the reason matching runs on segment
     * arrays rather than on the rendered string.
     *
     * The limitation this implies is real and deliberate: a key that itself
     * contains a `.` cannot be allowlisted at all, because the grammar has no
     * way to spell one. It is recorded in `docs/log-redaction.md`; nothing in
     * this repository logs such a key, and the failure is a redacted field
     * rather than an exposed one.
     */
    it("does not let a dotted key reach a nested allowlist entry", () => {
      expect(redact({ a: { b: "nested" } }, ["a.b"])).toEqual({ a: { b: "nested" } });
      expect(redact({ "a.b": "impersonated" }, ["a.b"])).toEqual({ "a.b": REDACTED });
      expect(redact({ "a.b": "impersonated" }, ["a", "b"])).toEqual({ "a.b": REDACTED });
    });

    it("does not mutate the fields it was given", () => {
      const fields = { order: { id: "o-1", note: "sensitive" } };
      redact(fields, ["order.id"]);
      expect(fields.order.note).toBe("sensitive");
    });
  });
});
