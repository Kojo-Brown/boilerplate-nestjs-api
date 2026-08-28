/**
 * The topic every domain event is produced to and consumed from.
 *
 * A token rather than a `ConfigService.get` at each call site, so the producer
 * and the consumer cannot end up pointed at different topics — the failure that
 * looks exactly like a broker losing messages and is found by reading the
 * environment rather than the logs.
 */
export const DOMAIN_EVENTS_TOPIC = Symbol("DOMAIN_EVENTS_TOPIC");

/**
 * The topic messages go to once the consumer has given up on them, or `null`
 * when dead-lettering is disabled.
 *
 * `null` rather than an absent provider, so that "dead-lettering is off" is a
 * value the injector hands out and a state `DeadLetterQueue.enabled` can report,
 * instead of a resolution failure at boot in one configuration and not another.
 */
export const DEAD_LETTER_TOPIC = Symbol("DEAD_LETTER_TOPIC");

/**
 * Optional DI token for the retry ladder's jitter source.
 *
 * Mirrors `OUTBOX_JITTER`: production leaves it unbound and gets `Math.random`,
 * a test binds it to pin the schedule and keep the suite off the clock.
 */
export const DEAD_LETTER_JITTER = Symbol("DEAD_LETTER_JITTER");
