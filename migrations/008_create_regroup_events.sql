CREATE TABLE regroup_events (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  created_by  TEXT             NOT NULL REFERENCES users(id),
  type        TEXT             NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
