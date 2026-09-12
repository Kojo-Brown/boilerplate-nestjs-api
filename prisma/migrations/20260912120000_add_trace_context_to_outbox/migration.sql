-- The W3C trace context of the request that staged the event, so the message
-- the relay publishes minutes later can name that request as its parent rather
-- than the poll that happened to claim the row.
--
-- Both nullable and with no default: a row staged before this migration, or
-- staged while telemetry was switched off, genuinely has no context, and
-- inventing one would produce a `traceparent` pointing at a span that never
-- existed. `ALTER TABLE ... ADD COLUMN` of a nullable column with no default is
-- a catalogue-only change in PostgreSQL 11+, so this does not rewrite the table
-- and takes no lock worth planning a deploy around.
ALTER TABLE "outbox_events" ADD COLUMN "traceparent" TEXT;
ALTER TABLE "outbox_events" ADD COLUMN "tracestate" TEXT;
