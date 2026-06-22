ALTER TABLE user_memberships
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS apple_product_id              TEXT,
  ADD COLUMN IF NOT EXISTS apple_environment             TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS user_memberships_apple_txn_idx
  ON user_memberships (apple_original_transaction_id)
  WHERE apple_original_transaction_id IS NOT NULL;
