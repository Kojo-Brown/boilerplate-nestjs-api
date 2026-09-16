-- CreateTable
CREATE TABLE "audit_log" (
    "seq" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "correlationId" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_hash_key" ON "audit_log"("hash");

-- CreateIndex
CREATE INDEX "audit_log_resourceType_resourceId_seq_idx" ON "audit_log"("resourceType", "resourceId", "seq");

-- CreateIndex
CREATE INDEX "audit_log_actorId_seq_idx" ON "audit_log"("actorId", "seq");

-- Append-only enforcement.
--
-- The hash chain detects tampering after the fact; this refuses it up front, so
-- an ORM typo, a `DELETE` with a forgotten `WHERE`, or a compromised
-- application role cannot quietly rewrite history in the first place. Both are
-- needed and neither replaces the other: a trigger the table owner can drop is
-- not evidence, and evidence that only arrives when somebody remembers to
-- verify is not a control.
--
-- SQLSTATE `AU001` is a user-defined code (Postgres reserves only class 00, and
-- allows any other five-character code made of digits and upper-case letters).
-- It is stated here rather than left as plpgsql's default `P0001` so that a
-- caller can recognise this specific refusal without matching on English text.
CREATE OR REPLACE FUNCTION audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'AU001',
              HINT = 'Entries are written once. Correct the record by appending a new entry.';
END;
$$;

-- FOR EACH ROW, so the exception names the operation that was attempted even
-- when the statement matched nothing else.
CREATE TRIGGER audit_log_no_update_or_delete
    BEFORE UPDATE OR DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

-- TRUNCATE fires no row-level trigger at all, which is precisely why it is the
-- statement somebody reaching for a clean slate would use.
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON "audit_log"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();
