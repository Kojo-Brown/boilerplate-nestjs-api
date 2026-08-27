/**
 * The topic every domain event is produced to and consumed from.
 *
 * A token rather than a `ConfigService.get` at each call site, so the producer
 * and the consumer cannot end up pointed at different topics — the failure that
 * looks exactly like a broker losing messages and is found by reading the
 * environment rather than the logs.
 */
export const DOMAIN_EVENTS_TOPIC = Symbol("DOMAIN_EVENTS_TOPIC");
