CREATE TABLE ride_summaries (
  id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id                UUID             NOT NULL UNIQUE REFERENCES rides(id),
  duration_seconds       INTEGER          NOT NULL,
  distance_meters        DOUBLE PRECISION NOT NULL,
  avg_speed_kmh          DOUBLE PRECISION,
  max_group_split_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
  compactness_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_regroups         INTEGER          NOT NULL DEFAULT 0,
  total_emergencies      INTEGER          NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ      NOT NULL DEFAULT now()
);
