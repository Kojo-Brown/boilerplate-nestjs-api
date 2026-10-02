import {
  MissingTenantContextError,
  currentTenant,
  currentTenantId,
  enterTenant,
  isTenantId,
  outsideAnyTenant,
  requireTenantId,
  runInTenant,
  runInTenantContext,
} from "./tenant-context";

describe("isTenantId", () => {
  // The same expression is a CHECK constraint on `tenants.id` and is what the
  // resolver, `runInTenant` and `JwtStrategy` all validate against — so what it
  // accepts is a decision about what can be a subdomain, a header value and a
  // primary key at once.
  it.each([["acme"], ["acme-corp"], ["a1"], ["x".repeat(63)], ["1" + "x".repeat(61) + "9"]])(
    "accepts %p",
    (value) => {
      expect(isTenantId(value)).toBe(true);
    },
  );

  it.each([
    ["", "empty"],
    ["a", "one character — the first and last have to be alphanumeric, so two is the floor"],
    ["Acme", "upper case, which a hostname cannot distinguish"],
    ["acme.corp", "a dot, which would make one id resolve two ways under a base domain"],
    ["acme_corp", "an underscore, which is not valid in a hostname"],
    ["-acme", "a leading dash"],
    ["acme-", "a trailing dash"],
    ["x".repeat(64), "longer than a DNS label may be"],
    ["acme corp", "a space"],
  ])("rejects %p (%s)", (value) => {
    expect(isTenantId(value)).toBe(false);
  });
});

describe("the tenant in scope", () => {
  it("is undefined outside any context", () => {
    expect(currentTenantId()).toBeUndefined();
    expect(currentTenant()).toBeUndefined();
  });

  it("is whatever the enclosing runInTenant set", () => {
    const seen = runInTenant("acme", () => currentTenant());

    expect(seen).toEqual({ tenantId: "acme", source: "explicit" });
  });

  it("survives an await, which is the whole reason it is an AsyncLocalStorage", async () => {
    const seen = await runInTenant("acme", async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return currentTenantId();
    });

    expect(seen).toBe("acme");
  });

  it("restores the outer tenant when an inner scope ends", () => {
    const seen = runInTenant("acme", () => {
      const inner = runInTenant("globex", () => currentTenantId());
      return { inner, after: currentTenantId() };
    });

    expect(seen).toEqual({ inner: "globex", after: "acme" });
  });

  it("leaves no tenant behind after the callback returns", () => {
    runInTenant("acme", () => undefined);

    expect(currentTenantId()).toBeUndefined();
  });

  it("refuses an id that could not be stored", () => {
    // The validation is here rather than only at the edges because this is the
    // entry point for work whose tenant came from a job payload or a script
    // argument, and the value reaches `set_config` unaltered.
    expect(() => runInTenant("Acme Corp", () => undefined)).toThrow(TypeError);
  });

  it("carries where the tenant came from, for the access log", () => {
    const seen = runInTenantContext({ tenantId: "acme", source: "host" }, () => currentTenant());

    expect(seen).toEqual({ tenantId: "acme", source: "host" });
  });
});

describe("requireTenantId", () => {
  it("returns the tenant in scope", () => {
    expect(runInTenant("acme", () => requireTenantId("a read"))).toBe("acme");
  });

  it("names the caller in the error, because the stack trace will not", () => {
    expect(() => requireTenantId("user.findMany")).toThrow(MissingTenantContextError);
    expect(() => requireTenantId("user.findMany")).toThrow(/user\.findMany/);
    // The message has to say what to do, because the fix is never in the frame
    // that threw: it is wherever the work was started.
    expect(() => requireTenantId("user.findMany")).toThrow(/runInTenant/);
  });
});

describe("enterTenant", () => {
  // Called inside each test body, which is the only place it can be trusted: an
  // `AsyncLocalStorage` scope belongs to the execution context that opens it, and a
  // jest hook's context is not reliably an ancestor of the test's. `beforeEach` with
  // an `enterTenant` in it passed locally and failed thirteen tests on CI, which is
  // why `auth.service.spec.ts` wraps its bodies instead.
  it("sets the tenant for the rest of this context, with no scope to leave", () => {
    enterTenant("acme");

    expect(currentTenantId()).toBe("acme");
  });

  it("is still in force after an await", async () => {
    enterTenant("globex");
    await Promise.resolve();

    expect(currentTenantId()).toBe("globex");
  });

  it("refuses an id that could not be stored", () => {
    expect(() => enterTenant("")).toThrow(TypeError);
  });
});

describe("outsideAnyTenant", () => {
  it("removes the tenant that was in scope", () => {
    const seen = runInTenant("acme", () => outsideAnyTenant(() => currentTenantId()));

    expect(seen).toBeUndefined();
  });

  it("gives it back when the callback ends", () => {
    const seen = runInTenant("acme", () => {
      outsideAnyTenant(() => undefined);
      return currentTenantId();
    });

    expect(seen).toBe("acme");
  });

  it("covers an async callback's continuations, not just its first frame", async () => {
    const seen = await runInTenant("acme", () =>
      outsideAnyTenant(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return currentTenantId();
      }),
    );

    expect(seen).toBeUndefined();
  });
});
