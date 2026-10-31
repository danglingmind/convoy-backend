import { pool } from './pool';
import { TrackPoint } from '../types';

export async function insertTrackPoints(rideId: string, points: TrackPoint[]): Promise<void> {
  if (points.length === 0) return;
  const values: unknown[] = [rideId];
  const rows = points.map((p, i) => {
    values.push(p.lat, p.lng, p.offRoute);
    return `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`;
  });
  await pool.query(
    `INSERT INTO ride_track_points (ride_id, lat, lng, off_route) VALUES ${rows.join(', ')}`,
    values
  );
}

export async function getTrackPoints(rideId: string): Promise<TrackPoint[]> {
  const { rows } = await pool.query<{ lat: number; lng: number; off_route: boolean }>(
    `SELECT lat, lng, off_route FROM ride_track_points WHERE ride_id = $1 ORDER BY id`,
    [rideId]
  );
  return rows.map((r) => ({ lat: r.lat, lng: r.lng, offRoute: r.off_route }));
}

export async function saveActualRoute(
  rideId: string,
  polyline: string,
  distanceMeters: number
): Promise<void> {
  await pool.query(
    `UPDATE rides SET actual_route_polyline = $2, actual_distance_meters = $3 WHERE id = $1`,
    [rideId, polyline, distanceMeters]
  );
}

export async function getActualDistance(rideId: string): Promise<number | null> {
  const { rows } = await pool.query<{ actual_distance_meters: number | null }>(
    `SELECT actual_distance_meters FROM rides WHERE id = $1`,
    [rideId]
  );
  return rows[0]?.actual_distance_meters ?? null;
}

/** Retention: raw points are only needed to derive via points and reprocess; drop old ones. */
export async function deleteTrackPointsOlderThan(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM ride_track_points WHERE recorded_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return rowCount ?? 0;
}
