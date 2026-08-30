import { Global, Module } from "@nestjs/common";
import { EventContract } from "./event-contract.service";
import { LocalSchemaRegistry } from "./local-schema-registry";
import { SCHEMA_REGISTRY } from "./ports";

/**
 * Provides the process's event contracts.
 *
 * Global because both ends of the pipeline take it and neither owns it:
 * `OutboxModule` validates an event before it is durable, `MessagingModule`
 * validates it onto and off the wire. Making either import this would put the
 * contract behind one of the two modules it is supposed to sit between.
 *
 * There is no environment variable selecting an implementation, unlike
 * `MESSAGE_BROKER` or `IDEMPOTENCY_STORE`. That is not an omission: those enums
 * exist because there are two implementations to choose between, and adding one
 * here to choose between a single option would be configuration that can only
 * be set wrong.
 */
@Global()
@Module({
  providers: [
    // `useFactory`, not `useClass`: `LocalSchemaRegistry` takes the catalogue as
    // a defaulted constructor parameter so tests can supply their own, and Nest
    // would try to resolve that parameter rather than let the default apply.
    { provide: SCHEMA_REGISTRY, useFactory: (): LocalSchemaRegistry => new LocalSchemaRegistry() },
    EventContract,
  ],
  exports: [SCHEMA_REGISTRY, EventContract],
})
export class SchemaRegistryModule {}
