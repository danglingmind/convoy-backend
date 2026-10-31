import { pool } from './pool';
import { RegroupType } from '../types';

export interface RegroupRow {
  id: string;
  ride_id: string;
  created_by: string;
  type: RegroupType;
  lat: number;
  lng: number;
  resolved_at: Date | null;
  created_at: Date;
}

export async function createRegroupEvent(
  rideId: string,
  createdBy: string,
  type: RegroupType,
  lat: number,
  lng: number
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO regroup_events (ride_id, created_by, type, lat, lng)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [rideId, createdBy, type, lat, lng]
  );
  return rows[0].id;
}

export type RegroupCloseReason = 'RESOLVED' | 'DISMISSED' | 'SUPERSEDED' | 'CAPPED' | 'RIDE_ENDED';

export async function resolveRegroupEvent(id: string, reason: RegroupCloseReason): Promise<void> {
  await pool.query(
    `UPDATE regroup_events SET resolved_at = now(), close_reason = $2 WHERE id = $1`,
    [id, reason]
  );
}

/** Closes whatever is still open when a ride ends, whether or not in-memory state survived. */
export async function closeOpenRegroupsForRide(rideId: string): Promise<void> {
  await pool.query(
    `UPDATE regroup_events SET resolved_at = now(), close_reason = 'RIDE_ENDED'
     WHERE ride_id = $1 AND resolved_at IS NULL`,
    [rideId]
  );
}

export interface LeaderStopRow {
  id: string;
  type: RegroupType;
  lat: number;
  lng: number;
  created_at: Date;
}

/** Regroups the ride leader called, minus ones they immediately replaced (mis-taps). Emergencies
 *  live in their own table, so they never appear here. Rows from before close_reason existed
 *  have NULL and count as real stops. */
export async function listLeaderStops(rideId: string): Promise<LeaderStopRow[]> {
  const { rows } = await pool.query<LeaderStopRow>(
    `SELECT e.id, e.type, e.lat, e.lng, e.created_at
     FROM regroup_events e
     JOIN rides r ON r.id = e.ride_id
     WHERE e.ride_id = $1
       AND e.created_by = r.leader_id
       AND e.close_reason IS DISTINCT FROM 'SUPERSEDED'
     ORDER BY e.created_at`,
    [rideId]
  );
  return rows;
}

export async function countRegroupEvents(rideId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM regroup_events WHERE ride_id = $1`,
    [rideId]
  );
  return parseInt(rows[0].count, 10);
}
