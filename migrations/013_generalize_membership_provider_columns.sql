-- Generalize user_memberships from Apple-only to any store provider.
--
-- Before this migration the only purchase identity on the table was
-- `apple_original_transaction_id`, which is also what the activate upsert
-- arbitrated on. Google Play has no analogue of an original transaction id, so
-- a Play purchase had nothing to key on and could not be recorded at all.
--
-- Deliberately additive and rollback-safe:
--   * the apple_* columns and `user_memberships_apple_txn_idx` are LEFT IN PLACE,
--     and the application keeps writing them for Apple rows, so redeploying the
--     previous build against this schema still works;
--   * every new column is nullable, so rows written by the previous build (which
--     knows nothing about them) remain valid;
--   * the new unique index is partial on NOT NULL, so pre-existing rows with no
--     purchase attached (manual grants, comped memberships) are simply excluded
--     rather than colliding with each other on (NULL, NULL).
--
-- CREATE UNIQUE INDEX is not CONCURRENTLY because the migration runner wraps each
-- file in a transaction and CONCURRENTLY cannot run inside one. user_memberships
-- is a small table (one row per purchased subscription), so the brief ACCESS
-- EXCLUSIVE lock is not worth splitting the migration in two to avoid.

ALTER TABLE user_memberships
  ADD COLUMN IF NOT EXISTS provider                TEXT,
  ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_product_id     TEXT,
  ADD COLUMN IF NOT EXISTS provider_environment    TEXT;

-- Backfill every existing Apple purchase into the generic columns. Guarded on
-- `provider IS NULL` so re-running against a partially migrated table cannot
-- overwrite rows that have already been claimed by a provider.
UPDATE user_memberships
   SET provider                = 'apple',
       provider_transaction_id = apple_original_transaction_id,
       provider_product_id     = apple_product_id,
       provider_environment    = apple_environment
 WHERE apple_original_transaction_id IS NOT NULL
   AND provider IS NULL;

-- Purchase identity is only unique *within* a store: nothing stops Apple and
-- Google from independently issuing the same opaque string, so the provider is
-- part of the key rather than a bare column.
--
-- This index cannot fail on existing data: Apple rows inherit their ids from
-- `user_memberships_apple_txn_idx`, which already enforced uniqueness over
-- exactly the same set of rows.
CREATE UNIQUE INDEX IF NOT EXISTS user_memberships_provider_txn_idx
  ON user_memberships (provider, provider_transaction_id)
  WHERE provider IS NOT NULL AND provider_transaction_id IS NOT NULL;

-- Reject anything that is not a store we actually verify against. NOT VALID so
-- the constraint applies to new writes without scanning existing rows; the
-- backfill above has already made every existing row satisfy it.
ALTER TABLE user_memberships
  DROP CONSTRAINT IF EXISTS user_memberships_provider_check;
ALTER TABLE user_memberships
  ADD CONSTRAINT user_memberships_provider_check
  CHECK (provider IS NULL OR provider IN ('apple', 'google')) NOT VALID;
