-- Free plan: 3 ride participations per month (was 10). Riders per ride stays at 5.
-- Premium is unchanged (unlimited rides, 25 riders).
UPDATE membership_plans
SET monthly_ride_participation_limit = 3
WHERE code = 'free';
