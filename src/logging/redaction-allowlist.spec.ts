import {
  DEFAULT_ALLOWLIST,
  compileAllowlist,
  isPermittedOperatorPattern,
} from "./redaction-allowlist";

describe("compileAllowlist", () => {
  it("admits a path it was given", () => {
    const { allowlist } = compileAllowlist(["query.page"]);
    expect(allowlist.admits(["query", "page"])).toBe(true);
  });

  it("does not admit a path it was not given", () => {
    const { allowlist } = compileAllowlist(["query.page"]);
    expect(allowlist.admits(["query", "code"])).toBe(false);
  });

  /**
   * Returned rather than ignored, so `envSchema` can name the entry in a boot
   * failure. An allowlist that silently discards a malformed line is a field an
   * operator believes is being logged and which is not there on the day they
   * look for it.
   */
  it("reports an unparseable pattern instead of dropping it quietly", () => {
    const { allowlist, rejected } = compileAllowlist(["query.page", "a..b", ""]);
    expect(rejected).toEqual(["a..b", ""]);
    expect(allowlist.patterns).toEqual(["query.page"]);
  });

  it("admits paths of different lengths from one list", () => {
    const { allowlist } = compileAllowlist(["userId", "order.id", "items[].sku"]);
    expect(allowlist.admits(["userId"])).toBe(true);
    expect(allowlist.admits(["order", "id"])).toBe(true);
    expect(allowlist.admits(["items", "[]", "sku"])).toBe(true);
    expect(allowlist.admits(["order"])).toBe(false);
  });
});

describe("DEFAULT_ALLOWLIST", () => {
  const { allowlist, rejected } = compileAllowlist(DEFAULT_ALLOWLIST);

  it("is entirely parseable", () => {
    expect(rejected).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(DEFAULT_ALLOWLIST).size).toBe(DEFAULT_ALLOWLIST.length);
  });

  it("admits the access log's own fields", () => {
    for (const path of [
      ["correlationId"],
      ["method"],
      ["path"],
      ["statusCode"],
      ["latencyMs"],
      ["userId"],
      ["trace_id"],
      ["span_id"],
    ]) {
      expect(allowlist.admits(path)).toBe(true);
    }
  });

  /**
   * The regression guard for the leak this module was written for. `query.*`
   * would have been the convenient entry and would have admitted the OAuth
   * authorisation code; the pagination parameters are named one at a time
   * instead, so a parameter nobody has considered is redacted.
   */
  it("admits pagination parameters and nothing else in the query string", () => {
    expect(allowlist.admits(["query", "page"])).toBe(true);
    expect(allowlist.admits(["query", "limit"])).toBe(true);
    for (const parameter of ["code", "state", "token", "access_token", "email", "lastEventId"]) {
      expect(allowlist.admits(["query", parameter])).toBe(false);
    }
  });

  it("contains no wildcard as a whole segment, which would admit a shape nobody reviewed", () => {
    expect(DEFAULT_ALLOWLIST.filter((pattern) => pattern.split(".").includes("*"))).toEqual([]);
  });

  it("admits no field whose name suggests personal data", () => {
    const suspicious =
      /email|phone|address|name|dob|birth|ssn|passport|card|secret|token|password/i;
    expect(DEFAULT_ALLOWLIST.filter((pattern) => suspicious.test(pattern))).toEqual([]);
  });
});

describe("isPermittedOperatorPattern", () => {
  /**
   * `LOG_REDACTION_EXTRA_ALLOWLIST=*` parses perfectly, admits every top-level
   * field of every record, and reads in a deployment manifest like configuration
   * rather than like the disabled redactor it is. `LOG_REDACTION_ENABLED=false`
   * is the honest spelling, and it is refused in production — so this closes the
   * way around it.
   */
  it.each(["*", "*.id", "*.*"])("refuses a pattern beginning with a wildcard: %s", (pattern) => {
    expect(isPermittedOperatorPattern(pattern)).toBe(false);
  });

  it("permits a wildcard deeper in a pattern, which no fixed list can express", () => {
    expect(isPermittedOperatorPattern("counts.*")).toBe(true);
  });

  it.each(["order.currency", "items[].sku", "region"])("permits %s", (pattern) => {
    expect(isPermittedOperatorPattern(pattern)).toBe(true);
  });

  it("refuses an unparseable pattern", () => {
    expect(isPermittedOperatorPattern("a..b")).toBe(false);
  });
});
