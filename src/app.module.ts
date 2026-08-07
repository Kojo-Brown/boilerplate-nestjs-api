import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./common/prisma/prisma.module";
import { AppCacheModule } from "./common/cache";
import { AspectsModule } from "./common/aspects";
import { UsersModule } from "./users/users.module";
import { AuthModule } from "./auth/auth.module";
import { StorageModule } from "./storage/storage.module";
import { PaymentsModule } from "./payments/payments.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { HealthModule } from "./health/health.module";
import { QueueModule } from "./queue/queue.module";
import { ShutdownModule } from "./common/shutdown/shutdown.module";
import { ProxyAwareThrottlerGuard } from "./common/guards/throttler.guard";
import { envSchema } from "./config/env.schema";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
    }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AppCacheModule,
    // After AppCacheModule: `ASPECT_CACHE` is an alias of its `CacheService`.
    AspectsModule,
    AuthModule,
    UsersModule,
    StorageModule,
    PaymentsModule,
    NotificationsModule,
    HealthModule,
    QueueModule,
    ShutdownModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ProxyAwareThrottlerGuard }],
})
export class AppModule {}
