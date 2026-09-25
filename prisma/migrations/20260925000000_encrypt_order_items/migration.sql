-- Encrypt the order lines at rest.
--
-- `orders.items` was `jsonb` holding what a named customer bought, kept for the
-- lifetime of the account. It becomes an AES-256-GCM envelope under a
-- KMS-wrapped data key. See docs/field-encryption.md.
--
-- The type change is the point rather than an inconvenience: once the bytes are
-- ciphertext the database cannot see inside them, so `items->>'sku'`, a GIN
-- index and every `jsonb` predicate are gone. Nothing in this codebase used one
-- — the column is written whole and read whole — which is what made it a
-- candidate in the first place.

-- There is no backfill here, and unlike `20260923000000_add_refresh_token_families`
-- that is not because none was needed: it is because none is possible in SQL.
-- Encrypting an existing row means calling KMS for a data key, which Postgres
-- cannot do, and `pgcrypto` would mean handing the database the key — the one
-- arrangement this change exists to avoid.
--
-- So a table with rows in it stops the migration instead of losing them. A
-- silent `DROP COLUMN` here would destroy every order's contents on a deployment
-- that already has some, and an `ALTER … USING` cannot produce ciphertext. The
-- two-phase cutover for a populated deployment — add the column nullable,
-- encrypt through the application, then drop the plaintext — is written out in
-- docs/field-encryption.md; a boilerplate on a fresh database takes this path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders") THEN
    RAISE EXCEPTION
      'orders already holds rows, and their "items" cannot be encrypted by a SQL migration: a '
      'data key comes from KMS, which the database cannot call. Follow the cutover in '
      'docs/field-encryption.md (add "itemsCiphertext" nullable, encrypt through the '
      'application, then drop "items") instead of running this migration as it stands.';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "items",
                     ADD COLUMN "itemsCiphertext" BYTEA NOT NULL;
