-- The leader's actual ridden track, written during the ride (batched) and condensed into
-- rides.actual_route_polyline when the ride ends. `id` orders the points, so a rebuilt in-memory
-- ride state (server restart mid-ride) can keep appending without tracking a sequence number.
CREATE TABLE ride_track_points (
  id          BIGSERIAL        PRIMARY KEY,
  ride_id     UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  off_route   BOOLEAN          NOT NULL DEFAULT false,
  recorded_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX ride_track_points_ride_idx ON ride_track_points (ride_id, id);
CREATE INDEX ride_track_points_recorded_at_idx ON ride_track_points (recorded_at);
