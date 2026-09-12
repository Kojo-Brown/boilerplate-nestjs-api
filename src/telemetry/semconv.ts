/**
 * The semantic-convention attribute names this service writes by hand.
 *
 * `@opentelemetry/semantic-conventions` publishes the stable attributes from
 * its root and the experimental ones — which is all of `messaging.*` — from an
 * `/incubating` subpath. That subpath is declared through the package's
 * `exports` map, and `exports` is only consulted under `moduleResolution` of
 * `node16` or `bundler`; this project compiles to CommonJS with the classic
 * `node` resolver, so the import does not type-check. Changing the resolver for
 * three constants would change how *every* dependency in the project resolves,
 * which is not a trade worth making.
 *
 * So they are written out here, once, with the version they were taken from.
 * The strings are the wire format and are what a backend matches on — a
 * constant re-exported from a package and a constant declared here produce
 * identical telemetry. What is lost is the compiler noticing a rename, and the
 * experimental attributes do get renamed: `messaging.kafka.message.offset`
 * became `messaging.kafka.offset` in 1.27. That is what the version note is
 * for, and `docs/telemetry.md` says to re-check these when the package is
 * upgraded.
 *
 * Taken from @opentelemetry/semantic-conventions 1.43.0 (incubating).
 */
export const ATTR_MESSAGING_SYSTEM = "messaging.system";
export const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name";
export const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name";
export const ATTR_MESSAGING_DESTINATION_PARTITION_ID = "messaging.destination.partition.id";
export const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id";
export const ATTR_MESSAGING_CONSUMER_GROUP_NAME = "messaging.consumer.group.name";
export const ATTR_MESSAGING_KAFKA_OFFSET = "messaging.kafka.offset";

/**
 * Not a convention at all, and marked as such by the `app.` prefix the
 * specification reserves for exactly this: a name nobody else defines.
 *
 * `messaging.event.name` would read as though it came from the standard, which
 * matters the day somebody greps the conventions for it and finds nothing.
 */
export const ATTR_APP_EVENT_NAME = "app.event.name";

/** How a message ended: `handled`, `dead-lettered`, or `uncommitted`. */
export const ATTR_APP_MESSAGING_OUTCOME = "app.messaging.outcome";

/** The outbox row's disposition: `published`, `retry` or `dead`. */
export const ATTR_APP_OUTBOX_DISPOSITION = "app.outbox.disposition";
