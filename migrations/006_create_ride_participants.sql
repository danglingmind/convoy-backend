CREATE TABLE ride_participants (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id              UUID        NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id              TEXT        NOT NULL REFERENCES users(id),
  status               TEXT        NOT NULL DEFAULT 'JOINED',
  counted_toward_quota BOOLEAN     NOT NULL DEFAULT false,
  quota_consumed_at    TIMESTAMPTZ,
  ride_title           TEXT,
  sync_score           INTEGER,
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ride_id, user_id)
);
