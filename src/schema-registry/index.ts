export { SchemaRegistryModule } from "./schema-registry.module";
export { EventContract } from "./event-contract.service";
export { LocalSchemaRegistry } from "./local-schema-registry";
export { SCHEMA_CATALOGUE, REFERENCE_PAYLOADS } from "./catalogue";
export {
  assertFullyCompatible,
  assertHistoryIsFullyCompatible,
  checkCompatibility,
  BOTH_DIRECTIONS,
} from "./compatibility";
export type { CompatibilityDirection, Incompatibility } from "./compatibility";
export {
  JSON_SCHEMA_DRAFT,
  PRIMITIVE_TYPES,
  assertInProfile,
  isArrayNode,
  isObjectNode,
} from "./json-schema";
export type {
  ArraySchemaNode,
  EventSchema,
  JsonScalar,
  ObjectSchemaNode,
  PrimitiveType,
  ScalarSchemaNode,
  SchemaNode,
} from "./json-schema";
export {
  IncompatibleEvolutionError,
  SchemaCompilationError,
  SchemaProfileError,
  SchemaValidationError,
  SubjectNotRegisteredError,
} from "./schema-registry.errors";
export { SCHEMA_REGISTRY, SCHEMA_REGISTRY_NAMES } from "./ports";
export type {
  PayloadContract,
  RegisteredSchema,
  SchemaRegistry,
  SchemaRegistryName,
  Subject,
} from "./ports";
