INSERT INTO membership_plans (code, monthly_ride_participation_limit, max_riders_per_ride, ride_history_days, replay_enabled, analytics_enabled)
VALUES
  ('free',    10,   5,  30,  false, false),
  ('premium', NULL, 25, 365, false, true)
ON CONFLICT (code) DO NOTHING;
