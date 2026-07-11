import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";

@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Received shutdown signal: ${signal ?? "unknown"} — shutting down gracefully`);
  }
}
