import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { MtlsPeerGuard } from "./mtls-peer.guard";

/**
 * Binds the peer-authorisation guard for every route.
 *
 * Registered unconditionally, because whether mTLS is on is an environment
 * question and the module graph is built before any of it is read — the guard
 * itself is a pass-through when `MTLS_ENABLED` is off. Imported early in
 * `AppModule` so that this decision is made before the ones that assume a
 * caller: a request from an unknown workload should be refused before it is
 * rate-limited or has its token verified.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: MtlsPeerGuard }],
})
export class MtlsModule {}
