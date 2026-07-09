import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import { HealthCheck, HealthCheckService, DiskHealthIndicator, MemoryHealthIndicator } from "@nestjs/terminus";
import { PrismaHealthIndicator } from "./indicators/prisma.health-indicator";
import { SkipResponseEnvelope } from "@/common/decorators/skip-response-envelope.decorator";

const MEMORY_HEAP_THRESHOLD = 300 * 1024 * 1024; // 300 MB
const MEMORY_RSS_THRESHOLD = 500 * 1024 * 1024; // 500 MB
const DISK_THRESHOLD_PERCENT = 0.9; // 90%

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @SkipResponseEnvelope()
  @ApiOperation({ summary: "Health check", description: "Returns the health status of the API and its dependencies." })
  @ApiOkResponse({ description: "All health checks passed." })
  @ApiServiceUnavailableResponse({ description: "One or more health checks failed." })
  check() {
    return this.health.check([
      () => this.db.isHealthy("database"),
      () => this.disk.checkStorage("storage", { thresholdPercent: DISK_THRESHOLD_PERCENT, path: "/" }),
      () => this.memory.checkHeap("memory.heap", MEMORY_HEAP_THRESHOLD),
      () => this.memory.checkRSS("memory.rss", MEMORY_RSS_THRESHOLD),
    ]);
  }
}
