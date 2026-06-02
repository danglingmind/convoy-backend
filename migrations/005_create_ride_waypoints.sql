CREATE TABLE ride_waypoints (
  id         UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  "order"    INTEGER          NOT NULL,
  name       TEXT             NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  type       TEXT             NOT NULL,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);
