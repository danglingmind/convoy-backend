-- Simplified polyline of the route the leader actually rode, and its length. NULL for rides that
-- ended before track recording shipped (or where no usable fixes arrived).
ALTER TABLE rides
  ADD COLUMN actual_route_polyline    TEXT,
  ADD COLUMN actual_distance_meters   DOUBLE PRECISION;
