-- Per-user push category switches. No row = everything on. Safety alerts are not switchable.
CREATE TABLE notification_preferences (
  user_id      TEXT        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ride_updates BOOLEAN     NOT NULL DEFAULT true,
  regroup      BOOLEAN     NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
