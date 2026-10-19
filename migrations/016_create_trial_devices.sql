-- One free trial per device, not per account. A rider who signs up again on the same phone
-- inherits that device's trial end instead of starting a fresh 3 days. `device_id` is an opaque,
-- app-generated identifier (iOS: a Keychain UUID; Android: SHA-256 of ANDROID_ID + app salt) —
-- never a hardware or advertising id. Kept when the account is deleted (first_user_id → NULL),
-- since forgetting it is exactly what a repeat trial would rely on.
CREATE TABLE trial_devices (
  device_id      TEXT        PRIMARY KEY,
  first_user_id  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  trial_ends_at  TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
