import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { preferencesExtension } from "./prisma.extensions";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
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
