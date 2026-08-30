import { EventContract, LocalSchemaRegistry } from "@/schema-registry";

/**
 * The real contract over the real catalogue, for tests that need one.
 *
 * Deliberately not a stub. Everything on the produce and consume paths now
 * validates against a schema, so a test that substituted a permissive fake would
 * be asserting the behaviour of a system without contracts — and the first thing
 * it would stop noticing is a payload the shipped schemas reject, which is
 * exactly the failure these tests exist to catch. Compiling the catalogue is a
 * few milliseconds once per suite.
 *
 * A test that wants a *different* catalogue — one with two versions, or a schema
 * built to fail — constructs `new EventContract(new LocalSchemaRegistry(...))`
 * with its own, which is why the registry takes the catalogue as an argument.
 */
export function realEventContract(): EventContract {
  return new EventContract(new LocalSchemaRegistry());
}
