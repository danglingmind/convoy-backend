import { randomBytes } from 'crypto';
import { pool } from './pool';

const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateShareToken(): string {
  const bytes = randomBytes(10);
  let token = '';
  for (let i = 0; i < 10; i++) token += CHARSET[bytes[i] % CHARSET.length];
  return token;
}

/** Returns the ride's share token, creating it on first use, and (re)enables the link. */
export async function getOrCreateShareToken(rideId: string): Promise<string> {
  const { rows } = await pool.query<{ share_token: string | null }>(
    `SELECT share_token FROM rides WHERE id = $1`, [rideId]
  );
  if (rows[0]?.share_token) {
    await pool.query(`UPDATE rides SET share_enabled = true WHERE id = $1`, [rideId]);
    return rows[0].share_token;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateShareToken();
    try {
      // Only set when still NULL, so two simultaneous first shares agree on one token.
      const res = await pool.query<{ share_token: string }>(
        `UPDATE rides SET share_token = COALESCE(share_token, $2), share_enabled = true
         WHERE id = $1 RETURNING share_token`,
        [rideId, token]
      );
      return res.rows[0].share_token;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err; // unique collision: retry
    }
  }
  throw new Error('could not allocate share token');
}

export async function disableShare(rideId: string): Promise<void> {
  await pool.query(`UPDATE rides SET share_enabled = false WHERE id = $1`, [rideId]);
}

export interface SharedRouteRow {
  ride_id: string;
  title: string;
  status: string;
  route_polyline: string;
  actual_route_polyline: string | null;
  distance_meters: number;
  actual_distance_meters: number | null;
  destination_name: string;
  destination_lat: number;
  destination_lng: number;
  ended_at: Date | null;
  leader_name: string | null;
  duration_seconds: number | null;
  rider_count: number;
  start_lat: number | null;
  start_lng: number | null;
  via_points: { lat: number; lng: number }[] | null;
}

export async function getSharedRoute(token: string): Promise<SharedRouteRow | null> {
  const { rows } = await pool.query<SharedRouteRow>(
    `SELECT r.id AS ride_id, r.title, r.status, r.route_polyline, r.actual_route_polyline,
            r.distance_meters, r.actual_distance_meters, r.via_points,
            r.destination_name, r.destination_lat, r.destination_lng, r.ended_at,
            u.name AS leader_name,
            rs.duration_seconds,
            (SELECT COUNT(*)::int FROM ride_participants rp
               WHERE rp.ride_id = r.id AND rp.status != 'LEFT') AS rider_count,
            (SELECT lat FROM ride_waypoints w WHERE w.ride_id = r.id AND w.type = 'START' LIMIT 1) AS start_lat,
            (SELECT lng FROM ride_waypoints w WHERE w.ride_id = r.id AND w.type = 'START' LIMIT 1) AS start_lng
     FROM rides r
     JOIN users u ON u.id = r.leader_id
     LEFT JOIN ride_summaries rs ON rs.ride_id = r.id
     WHERE r.share_token = $1 AND r.share_enabled = true AND r.status = 'COMPLETED'`,
    [token]
  );
  return rows[0] ?? null;
}

export async function getSharedWaypoints(rideId: string): Promise<
  { order: number; name: string; lat: number; lng: number; type: string }[]
> {
  const { rows } = await pool.query(
    `SELECT "order", name, lat, lng, type FROM ride_waypoints
     WHERE ride_id = $1 AND type != 'START' ORDER BY "order"`,
    [rideId]
  );
  return rows;
}

/** Resolves a share token to its ride id for a clone, whether or not the link is still on:
 *  the clone is already happening, this only records where it came from. */
export async function markCloned(newRideId: string, sourceToken: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE rides SET cloned_from_ride_id = src.id
     FROM (SELECT id FROM rides WHERE share_token = $2) src
     WHERE rides.id = $1`,
    [newRideId, sourceToken]
  );
  return (rowCount ?? 0) > 0;
}
