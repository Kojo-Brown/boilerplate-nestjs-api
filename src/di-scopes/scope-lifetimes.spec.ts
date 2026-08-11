import { ContextIdFactory } from "@nestjs/core";
import type { ContextId } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { AuditTrailService } from "./audit-trail.service";
import { DiScopesController } from "./di-scopes.controller";
import { DiScopesModule } from "./di-scopes.module";
import { FeatureFlagCache } from "./feature-flag-cache.service";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { RequestContextResolver } from "./request-context.resolver";
import { RequestContextService } from "./request-context.service";
import { ScopedLogger } from "./scoped-logger.service";
import { SingletonAuditTrail } from "./singleton-audit-trail.service";

/**
 * What each scope actually does to instance lifetime, asserted against a real
 * container rather than an HTTP round trip.
 *
 * A request is simulated the way Nest's own router does it: mint a context id,
 * bind a request object to it, then resolve through that id. Every instance the
 * router would have built for a request is built here, keyed the same way, so
 * "two requests" is two context ids and "the same request" is one. The e2e
 * suite drives the same graph over HTTP; this one can ask questions HTTP
 * cannot, like whether two resolutions returned the identical object.
 */
describe("Provider scopes", () => {
  let moduleRef: TestingModule;
  let ledger: InstantiationLedger;

  interface FakeRequest extends Record<PropertyKey, unknown> {
    method: string;
    url: string;
    headers: Record<string, string>;
  }

  const requestFor = (correlationId: string): FakeRequest => ({
    method: "GET",
    url: "/v1/di-scopes",
    headers: { "x-correlation-id": correlationId },
  });

  /** One simulated request: a fresh context id with a request object bound to it. */
  async function startRequest(correlationId: string): Promise<{
    contextId: ContextId;
    request: FakeRequest;
    controller: DiScopesController;
  }> {
    const contextId = ContextIdFactory.create();
    const request = requestFor(correlationId);
    moduleRef.registerRequestByContextId(request, contextId);
    const controller = await moduleRef.resolve(DiScopesController, contextId);
    return { contextId, request, controller };
  }

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [DiScopesModule] }).compile();
    // `init()` is what runs `onApplicationBootstrap`, and — more importantly
    // here — what instantiates every singleton. Without it the counts below
    // would be measuring lazy resolution rather than scope.
    await moduleRef.init();
    ledger = moduleRef.get(InstantiationLedger);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe("Scope.DEFAULT", () => {
    it("constructs the provider once for the whole application", async () => {
      const before = ledger.countFor(FeatureFlagCache.name);

      const first = await startRequest("corr-1");
      const second = await startRequest("corr-2");

      expect(ledger.countFor(FeatureFlagCache.name)).toBe(before);
      expect(before).toBe(1);
      expect(first.controller).not.toBe(second.controller);
      expect(moduleRef.get(FeatureFlagCache)).toBe(moduleRef.get(FeatureFlagCache));
    });

    it("keeps memoised state across requests, which is the point of the scope", async () => {
      const flags = moduleRef.get(FeatureFlagCache);

      expect(flags.isEnabled("checkout.express", "user-1")).toBe(true);
      expect(flags.isEnabled("checkout.express", "user-1")).toBe(true);

      expect(flags.stats()).toEqual({ hits: 1, misses: 1, memoised: 1 });
    });

    it("treats an unknown flag as off", () => {
      const flags = moduleRef.get(FeatureFlagCache);

      expect(flags.isEnabled("checkout.expres", "user-1")).toBe(false);
      expect(flags.isEnabled("profile.avatar-crop", "user-1")).toBe(false);
    });
  });

  describe("Scope.REQUEST", () => {
    it("constructs one instance per request and reuses it within that request", async () => {
      const { contextId, controller } = await startRequest("corr-1");

      const resolvedAgain = await moduleRef.resolve(RequestContextService, contextId);
      const otherRequest = await startRequest("corr-2");
      const otherContext = await moduleRef.resolve(RequestContextService, otherRequest.contextId);

      // Same context id, same instance — not a copy carrying the same data.
      expect(await moduleRef.resolve(DiScopesController, contextId)).toBe(controller);
      expect(resolvedAgain).not.toBe(otherContext);
      expect(resolvedAgain.correlationId).toBe("corr-1");
      expect(otherContext.correlationId).toBe("corr-2");
    });

    it("reads the request it was built for", async () => {
      const { contextId } = await startRequest("corr-42");

      const context = await moduleRef.resolve(RequestContextService, contextId);

      expect(context.facts).toEqual({
        correlationId: "corr-42",
        method: "GET",
        path: "/v1/di-scopes",
      });
    });

    it("keeps per-request state private to its own request", async () => {
      const first = await moduleRef.resolve(
        RequestContextService,
        (await startRequest("corr-1")).contextId,
      );
      const second = await moduleRef.resolve(
        RequestContextService,
        (await startRequest("corr-2")).contextId,
      );

      first.set("tenant", "acme");

      expect(first.get("tenant")).toBe("acme");
      expect(second.get("tenant")).toBeUndefined();
    });

    it("survives being resolved with no request behind the context", async () => {
      // A queue consumer or a cron job resolving through a context id of its
      // own. `REQUEST` is unbound, and the provider has to cope rather than
      // throw at construction.
      const context = await moduleRef.resolve(RequestContextService, ContextIdFactory.create());

      expect(context.facts).toEqual({ correlationId: "none", method: "none", path: "none" });
    });
  });

  describe("Scope.TRANSIENT", () => {
    it("gives every injection site its own instance, named after its host", async () => {
      const { contextId } = await startRequest("corr-1");

      const controller = await moduleRef.resolve(DiScopesController, contextId);
      const report = await controller.report(requestFor("corr-1") as never);

      expect(report.transientLoggerHosts).toEqual([
        FeatureFlagCache.name,
        RequestContextService.name,
        DiScopesController.name,
      ]);
    });

    it("follows its host's lifetime rather than the request's", async () => {
      const singletonSites = 1; // FeatureFlagCache, built at init()
      const perRequestSites = 2; // RequestContextService and the controller

      expect(ledger.countFor(ScopedLogger.name)).toBe(singletonSites);

      await startRequest("corr-1");
      expect(ledger.countFor(ScopedLogger.name)).toBe(singletonSites + perRequestSites);

      await startRequest("corr-2");
      expect(ledger.countFor(ScopedLogger.name)).toBe(singletonSites + perRequestSites * 2);
    });

    it("names itself as its own host when resolved directly", async () => {
      // Nest passes the wrapper being resolved as the inquirer when nothing
      // else asked for it, so a transient resolved by hand is its own host
      // rather than an anonymous one.
      const resolved = await moduleRef.resolve(ScopedLogger);

      expect(resolved.host).toBe(ScopedLogger.name);
    });

    it("falls back to an unknown host when constructed outside the container", () => {
      // A unit test doing `new ScopedLogger(ledger)`. There is no inquirer to
      // read, and a logger that threw here would be a poor logger.
      expect(new ScopedLogger(ledger).host).toBe("unknown");
      expect(new ScopedLogger(ledger, "SOME_FACTORY_TOKEN").host).toBe("SOME_FACTORY_TOKEN");
    });
  });

  describe("Inherited request scope", () => {
    it("rebuilds a default-scoped provider per request when a dependency is request-scoped", async () => {
      expect(ledger.countFor(AuditTrailService.name)).toBe(0);

      const first = await startRequest("corr-1");
      const second = await startRequest("corr-2");

      expect(ledger.countFor(AuditTrailService.name)).toBe(2);
      expect(await moduleRef.resolve(AuditTrailService, first.contextId)).not.toBe(
        await moduleRef.resolve(AuditTrailService, second.contextId),
      );
    });

    it("loses everything the singleton buffer was supposed to accumulate", async () => {
      const bubbled = [];
      for (const correlationId of ["corr-1", "corr-2", "corr-3"]) {
        const { contextId, request } = await startRequest(correlationId);
        const controller = await moduleRef.resolve(DiScopesController, contextId);
        await controller.report(request as never);
        bubbled.push(await moduleRef.resolve(AuditTrailService, contextId));
      }

      // Three requests, three entries — but no instance ever saw more than its
      // own, because each was discarded with the request that built it.
      expect(bubbled.map((trail) => trail.entries().length)).toEqual([1, 1, 1]);

      // The same audit trail, kept a singleton by taking the correlation id as
      // an argument instead of injecting the request-scoped provider.
      const singleton = moduleRef.get(SingletonAuditTrail);
      expect(singleton.entries()).toEqual([
        { action: "di-scopes.report", correlationId: "corr-1" },
        { action: "di-scopes.report", correlationId: "corr-2" },
        { action: "di-scopes.report", correlationId: "corr-3" },
      ]);
      expect(ledger.countFor(SingletonAuditTrail.name)).toBe(1);
    });
  });

  describe("RequestContextResolver", () => {
    // That the resolver returns *the router's own* instance for a live request
    // is asserted in `test/di-scopes.e2e-spec.ts`, and can only be asserted
    // there: the id it keys off is attached to the request by the router, and
    // a hand-made context id is not the same thing however carefully it is
    // built. What this suite can prove is everything either side of that.

    it("binds a context for a carrier the router never touched", async () => {
      // A BullMQ job or a cron tick: no router, so no context id on the object.
      const job = { method: "JOB", url: "/jobs/nightly-report", headers: {} };

      const resolved = await moduleRef.get(RequestContextResolver).forRequest(job);

      expect(resolved.facts).toEqual({
        correlationId: "unassigned",
        method: "JOB",
        path: "/jobs/nightly-report",
      });
      // Same carrier, same context, same instance — a job that resolves twice
      // does not get two contexts.
      expect(await moduleRef.get(RequestContextResolver).forRequest(job)).toBe(resolved);
    });

    it("does not inherit the scope of what it resolves", () => {
      // The whole reason it exists: `moduleRef.get()` would throw for a
      // request-scoped provider, and succeeds here.
      expect(moduleRef.get(RequestContextResolver)).toBe(moduleRef.get(RequestContextResolver));
    });
  });
});
