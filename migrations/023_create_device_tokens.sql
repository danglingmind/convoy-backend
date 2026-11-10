-- Push notification device tokens (APNs for iOS, FCM for Android). A token belongs to one user at a
-- time: registering it from another account moves it. Deleted with the account.
CREATE TABLE device_tokens (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT        NOT NULL CHECK (platform IN ('ios', 'android')),
  token        TEXT        NOT NULL UNIQUE,
  locale       TEXT,
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_tokens_user ON device_tokens (user_id);
