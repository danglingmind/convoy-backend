-- via_points: one point mid-way through each stretch where the leader left the planned route,
-- so a clone can be routed along the roads actually ridden. NULL/empty when there was no detour.
-- cloned_from_ride_id: set when a ride is created from another ride's shared route.
ALTER TABLE rides
  ADD COLUMN via_points          JSONB,
  ADD COLUMN cloned_from_ride_id UUID REFERENCES rides(id) ON DELETE SET NULL;
