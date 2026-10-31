-- How a regroup ended: RESOLVED (everyone arrived), DISMISSED, SUPERSEDED (replaced by the same
-- rider's next regroup, typically a mis-tap), CAPPED (dropped past the open limit) or RIDE_ENDED.
-- NULL on rows from before this column; those count as real stops.
ALTER TABLE regroup_events ADD COLUMN close_reason TEXT;
