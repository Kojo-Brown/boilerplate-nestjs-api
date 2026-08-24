import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { PrismaTransactionRunner } from "./prisma-transaction.runner";
import { TRANSACTION_RUNNER } from "./transaction.port";

@Global()
@Module({
  providers: [
    PrismaService,
    // Bound by token so an application service depends on the port rather than
    // on Prisma, and so a suite can substitute a runner without a database.
    { provide: TRANSACTION_RUNNER, useClass: PrismaTransactionRunner },
  ],
  exports: [PrismaService, TRANSACTION_RUNNER],
})
export class PrismaModule {}
