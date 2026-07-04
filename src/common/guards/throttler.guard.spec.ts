import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { ProxyAwareThrottlerGuard } from "./throttler.guard";

class TestablePAThrottlerGuard extends ProxyAwareThrottlerGuard {
  async testGetTracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

describe("ProxyAwareThrottlerGuard", () => {
  let guard: TestablePAThrottlerGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      providers: [
        TestablePAThrottlerGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn(), get: jest.fn() } },
      ],
    }).compile();

    guard = module.get(TestablePAThrottlerGuard);
  });

  afterEach(() => jest.resetAllMocks());

  it("extracts the first IP from a comma-delimited x-forwarded-for header", async () => {
    const req = { headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" }, ip: "127.0.0.1" };
    expect(await guard.testGetTracker(req)).toBe("203.0.113.1");
  });

  it("handles an array-valued x-forwarded-for header", async () => {
    const req = { headers: { "x-forwarded-for": ["203.0.113.2", "10.0.0.2"] }, ip: "127.0.0.1" };
    expect(await guard.testGetTracker(req)).toBe("203.0.113.2");
  });

  it("falls back to req.ip when x-forwarded-for header is absent", async () => {
    const req = { headers: {}, ip: "192.168.1.5" };
    expect(await guard.testGetTracker(req)).toBe("192.168.1.5");
  });

  it("returns 'unknown' when neither header nor req.ip is present", async () => {
    const req = { headers: {} };
    expect(await guard.testGetTracker(req)).toBe("unknown");
  });

  it("ignores whitespace around each forwarded IP address", async () => {
    const req = { headers: { "x-forwarded-for": "  198.51.100.5  ,  10.0.0.3" }, ip: "127.0.0.1" };
    expect(await guard.testGetTracker(req)).toBe("198.51.100.5");
  });
});
