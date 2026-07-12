import { Test, TestingModule } from "@nestjs/testing";
import { HealthCheckError } from "@nestjs/terminus";
import { PrismaHealthIndicator } from "./prisma.health-indicator";
import { PrismaService } from "@/common/prisma/prisma.service";

const mockPrismaService = {
  $queryRaw: jest.fn(),
};

describe("PrismaHealthIndicator", () => {
  let indicator: PrismaHealthIndicator;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaHealthIndicator,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    indicator = module.get(PrismaHealthIndicator);
  });

  describe("isHealthy()", () => {
    it("returns a healthy status when the DB query succeeds", async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);

      const result = await indicator.isHealthy("database");

      expect(result).toMatchObject({ database: { status: "up" } });
    });

    it("throws HealthCheckError when the DB query fails", async () => {
      mockPrismaService.$queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(indicator.isHealthy("database")).rejects.toThrow(HealthCheckError);
    });

    it("includes the error message in HealthCheckError details", async () => {
      mockPrismaService.$queryRaw.mockRejectedValue(new Error("connection timeout"));

      try {
        await indicator.isHealthy("database");
        fail("expected HealthCheckError");
      } catch (err) {
        expect(err).toBeInstanceOf(HealthCheckError);
        const hce = err as HealthCheckError;
        expect(JSON.stringify(hce.causes)).toContain("connection timeout");
      }
    });

    it("handles non-Error thrown values without crashing", async () => {
      mockPrismaService.$queryRaw.mockRejectedValue("string rejection");

      await expect(indicator.isHealthy("database")).rejects.toThrow(HealthCheckError);
    });
  });
});
