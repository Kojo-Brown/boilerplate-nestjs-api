import { Global, Module } from "@nestjs/common";
import { RlsEnforcementService } from "./rls-enforcement.service";

/**
 * Tenancy, such as it needs a module at all.
 *
 * Most of this feature is not injectable: the context is an
 * `AsyncLocalStorage`, resolution is a pure function of the request's headers, and
 * the Prisma scoping is an extension `PrismaService` applies. What is left is the
 * boot-time check that the policies are actually in force, and `TenantGuard` —
 * which is registered in `app.module.ts` alongside the other global guards,
 * because the order they are consulted in is the order they are declared there
 * and it matters.
 *
 * Global so that `RlsEnforcementService` can be resolved by a spec without
 * importing this module, in the same spirit as the other cross-cutting modules.
 */
@Global()
@Module({
  providers: [RlsEnforcementService],
  exports: [RlsEnforcementService],
})
export class TenancyModule {}
