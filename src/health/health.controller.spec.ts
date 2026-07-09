import { Test, TestingModule } from "@nestjs/testing";
import { HealthCheckService, TerminusModule, DiskHealthIndicator, MemoryHealthIndicator } from "@nestjs/terminus";
import { HealthController } from "./health.controller";
import { PrismaHealthIndicator } from "./indicators/prisma.health-indicator";
import { Reflector } from "@nestjs/core";

const mockHealthCheck = jest.fn();
const mockDbCheck = jest.fn();
const mockDiskCheck = jest.fn();
const mockMemoryHeapCheck = jest.fn();
const mockMemoryRssCheck = jest.fn();

const mockHealthCheckService: Partial<HealthCheckService> = {
  check: mockHealthCheck,
};

const mockPrismaIndicator: Partial<PrismaHealthIndicator> = {
  isHealthy: mockDbCheck,
};

const mockDiskIndicator: Partial<DiskHealthIndicator> = {
  checkStorage: mockDiskCheck,
};

const mockMemoryIndicator: Partial<MemoryHealthIndicator> = {
  checkHeap: mockMemoryHeapCheck,
  checkRSS: mockMemoryRssCheck,
};

describe("HealthController", () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        Reflector,
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: PrismaHealthIndicator, useValue: mockPrismaIndicator },
        { provide: DiskHealthIndicator, useValue: mockDiskIndicator },
        { provide: MemoryHealthIndicator, useValue: mockMemoryIndicator },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("check()", () => {
    it("should invoke health.check with all four health-check callbacks", async () => {
      const expected = { status: "ok", info: {}, error: {}, details: {} };
      mockHealthCheck.mockResolvedValueOnce(expected);

      const result = await controller.check();

      expect(result).toStrictEqual(expected);
      expect(mockHealthCheck).toHaveBeenCalledTimes(1);
      const [checks] = mockHealthCheck.mock.calls[0] as [(() => unknown)[]];
      expect(checks).toHaveLength(4);
    });

    it("should propagate errors from health.check", async () => {
      mockHealthCheck.mockRejectedValueOnce(new Error("Service Unavailable"));

      await expect(controller.check()).rejects.toThrow("Service Unavailable");
    });
  });
});
