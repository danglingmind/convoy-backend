import { pool } from './pool';

export async function createEmergencyEvent(
  rideId: string,
  userId: string,
  lat: number,
  lng: number,
  message: string
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO emergency_events (ride_id, user_id, lat, lng, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [rideId, userId, lat, lng, message]
  );
  return rows[0].id;
}

export async function countEmergencyEvents(rideId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM emergency_events WHERE ride_id = $1`,
    [rideId]
  );
  return parseInt(rows[0].count, 10);
}
