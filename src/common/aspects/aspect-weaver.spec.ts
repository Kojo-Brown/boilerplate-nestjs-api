import { Controller, Injectable, Logger, Scope } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { FakeAspectClock, FakeAspectRandom } from "@/test-utils/fake-aspect-clock";
import { InMemoryAspectCache } from "@/test-utils/in-memory-aspect-cache";
import { AspectWeaver } from "./aspect-weaver.service";
import type { WeaveReport } from "./aspect-weaver.service";
import { Cacheable } from "./cacheable.decorator";
import { Retry } from "./retry.decorator";
import { Timed } from "./timed.decorator";
import { ASPECT_CACHE, ASPECT_CLOCK, ASPECT_RANDOM, METHOD_TIMING_RECORDER } from "./ports";
import type { MethodTiming } from "./ports";

@Injectable()
class DemoService {
  lookups = 0;
  flakyCalls = 0;
  combinedCalls = 0;
  failuresLeft = 0;

  @Cacheable({ ttlMs: 5_000, keyPrefix: "demo" })
  async lookup(id: string): Promise<string> {
    this.lookups += 1;
    return `user-${id}`;
  }

  @Retry({ attempts: 3, delayMs: 100, jitter: false })
  async flaky(): Promise<string> {
    this.flakyCalls += 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("transient");
    }
    return "recovered";
  }

  @Timed({ name: "demo.add" })
  add(a: number, b: number): number {
    return a + b;
  }

  @Timed({ name: "demo.combined" })
  @Cacheable()
  @Retry({ attempts: 3, delayMs: 100, jitter: false })
  async combined(key: string): Promise<string> {
    this.combinedCalls += 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("transient");
    }
    return `value-${key}`;
  }

  plain(): string {
    return "untouched";
  }
}

/** Proves the metadata is inherited: nothing is re-declared here. */
@Injectable()
class InheritingService extends DemoService {}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedService {
  @Timed()
  async run(): Promise<string> {
    return "run";
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientService {
  @Timed()
  async run(): Promise<string> {
    return "run";
  }
}

@Controller("demo")
class DemoController {
  @Timed()
  async list(): Promise<string> {
    return "list";
  }
}

describe("AspectWeaver", () => {
  let moduleRef: TestingModule;
  let weaver: AspectWeaver;
  let service: DemoService;
  let report: WeaveReport;
  let cache: InMemoryAspectCache;
  let clock: FakeAspectClock;
  let samples: MethodTiming[];
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    cache = new InMemoryAspectCache();
    clock = new FakeAspectClock();
    samples = [];
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "debug").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();

    moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [DemoController],
      providers: [
        DemoService,
        InheritingService,
        RequestScopedService,
        TransientService,
        AspectWeaver,
        { provide: ASPECT_CACHE, useValue: cache },
        { provide: ASPECT_CLOCK, useValue: clock },
        { provide: ASPECT_RANDOM, useValue: new FakeAspectRandom([1]) },
        {
          provide: METHOD_TIMING_RECORDER,
          useValue: { record: (timing: MethodTiming) => samples.push(timing) },
        },
      ],
    }).compile();

    // `init()` is what fires `onModuleInit`, and therefore the weaving.
    await moduleRef.init();
    weaver = moduleRef.get(AspectWeaver);
    service = moduleRef.get(DemoService);
    report = weaver.weave();
  });

  afterEach(async () => {
    await moduleRef.close();
    jest.restoreAllMocks();
  });

  describe("what it wraps", () => {
    it("leaves undecorated methods alone", () => {
      expect(service.plain()).toBe("untouched");
      expect(Object.getOwnPropertyNames(service)).not.toContain("plain");
    });

    it("keeps the wrapper indistinguishable from the method it replaced", () => {
      expect(service.lookup.name).toBe("lookup");
      expect(service.add.length).toBe(2);
    });

    it("does not stack a second chain when weaving runs again", async () => {
      // `report` above is the result of a second `weave()` on an already-woven
      // container; it must have found nothing left to do.
      expect(report.woven).toEqual([]);

      await service.lookup("a");
      await service.lookup("a");
      expect(service.lookups).toBe(1);
    });

    it("applies inherited aspect metadata to a subclass", async () => {
      const inheriting = moduleRef.get(InheritingService);

      await inheriting.lookup("a");
      await inheriting.lookup("a");

      expect(inheriting.lookups).toBe(1);
    });
  });

  describe("@Cacheable", () => {
    it("serves the second call from the cache", async () => {
      await expect(service.lookup("7")).resolves.toBe("user-7");
      await expect(service.lookup("7")).resolves.toBe("user-7");

      expect(service.lookups).toBe(1);
      expect([...cache.entries.keys()]).toEqual(['demo:DemoService.lookup:["7"]']);
    });

    it("keeps different arguments apart", async () => {
      await service.lookup("7");
      await service.lookup("8");

      expect(service.lookups).toBe(2);
    });
  });

  describe("@Retry", () => {
    it("recovers from a transient failure without the caller seeing it", async () => {
      service.failuresLeft = 2;

      await expect(service.flaky()).resolves.toBe("recovered");
      expect(service.flakyCalls).toBe(3);
      expect(clock.sleeps).toEqual([100, 200]);
    });

    it("surfaces the failure once the attempts are spent", async () => {
      service.failuresLeft = 5;

      await expect(service.flaky()).rejects.toThrow("transient");
      expect(service.flakyCalls).toBe(3);
    });
  });

  describe("@Timed", () => {
    it("measures a synchronous method without changing its return value", () => {
      expect(service.add(2, 3)).toBe(5);
      expect(samples).toEqual([
        expect.objectContaining({ name: "demo.add", outcome: "success", durationMs: 0 }),
      ]);
    });
  });

  describe("composition", () => {
    it("retries inside the cache and times the whole thing", async () => {
      service.failuresLeft = 1;

      await expect(service.combined("k")).resolves.toBe("value-k");
      await expect(service.combined("k")).resolves.toBe("value-k");

      // Retried once, then cached: the second call never reaches the method.
      expect(service.combinedCalls).toBe(2);
      expect(clock.sleeps).toEqual([100]);
      // Timed is outermost, so both calls are measured — and the first one's
      // duration includes the backoff the caller actually waited through.
      expect(samples.map((sample) => sample.durationMs)).toEqual([100, 0]);
    });
  });

  describe("what it refuses to wrap", () => {
    it("reports a decorated controller handler instead of pretending it works", () => {
      // `registerRouter()` runs before `onModuleInit`, so the router already
      // holds the original handler by the time weaving happens.
      expect(report.skipped).toContainEqual({
        target: "DemoController",
        method: "list",
        reason: "controller",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("DemoController.list()"));
    });

    it.each([["RequestScopedService"], ["TransientService"]])(
      "reports a decorated %s, whose real instances are created after weaving",
      (target) => {
        expect(report.skipped).toContainEqual({ target, method: "run", reason: "non-singleton" });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${target}.run()`));
      },
    );
  });
});
