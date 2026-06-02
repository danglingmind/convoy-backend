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

export async function resolveRegroupEvent(id: string): Promise<void> {
  await pool.query(
    `UPDATE regroup_events SET resolved_at = now() WHERE id = $1`,
    [id]
  );
}

export async function countRegroupEvents(rideId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM regroup_events WHERE ride_id = $1`,
    [rideId]
  );
  return parseInt(rows[0].count, 10);
}
