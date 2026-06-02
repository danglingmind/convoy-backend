CREATE TABLE membership_plans (
  id                               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                             TEXT        NOT NULL UNIQUE,
  monthly_ride_participation_limit INTEGER,
  max_riders_per_ride              INTEGER     NOT NULL,
  ride_history_days                INTEGER     NOT NULL,
  replay_enabled                   BOOLEAN     NOT NULL DEFAULT false,
  analytics_enabled                BOOLEAN     NOT NULL DEFAULT false,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
