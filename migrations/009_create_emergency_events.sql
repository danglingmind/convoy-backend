CREATE TABLE emergency_events (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id     TEXT             NOT NULL REFERENCES users(id),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  message     TEXT             NOT NULL,
  resolved    BOOLEAN          NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
