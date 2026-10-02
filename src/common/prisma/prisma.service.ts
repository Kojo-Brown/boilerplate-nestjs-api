import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { tenantScopeExtension } from "@/tenancy/tenant-prisma";
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

  /**
   * The client every tenant-owned read and write goes through.
   *
   * Tenant scoping is applied **first** and the preferences extension second,
   * which is the order that matters rather than a style choice: a model extension
   * calls back into the client it was applied to, so `getPreferences`' own
   * `findUnique` is wrapped by a query extension installed before it and is not
   * wrapped by one installed after. Reversed, the two custom methods on
   * `user` would be the only reads in this application that reached Postgres with
   * no tenant in scope — and under the policies they would quietly return nothing.
   *
   * `this` is handed to `tenantScopeExtension` as the client its batches run on.
   * It has to be the *unextended* client: the extension's own
   * `$transaction([setting, query])` would otherwise recurse through itself.
   */
  withExtensions() {
    return this.$extends(tenantScopeExtension(this)).$extends(preferencesExtension);
  }
}

export type ExtendedPrismaClient = ReturnType<PrismaService["withExtensions"]>;
