import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";
import { EmailQueueModule } from "./email/email-queue.module";

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          url: config.get("REDIS_URL", { infer: true }) ?? "redis://localhost:6379",
        },
      }),
      inject: [ConfigService],
    }),
    EmailQueueModule,
  ],
  exports: [EmailQueueModule],
})
export class QueueModule {}
