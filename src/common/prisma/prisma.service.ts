import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { preferencesExtension } from "./prisma.extensions";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * Prisma 7 removed the bundled Rust query engine: the client will not
   * construct without a driver adapter, and the connection string now comes
   * from the app config rather than from `schema.prisma`.
   */
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>("DATABASE_URL"),
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  withExtensions() {
    return this.$extends(preferencesExtension);
  }
}

export type ExtendedPrismaClient = ReturnType<PrismaService["withExtensions"]>;
