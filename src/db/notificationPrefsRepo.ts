import { pool } from './pool';

export interface NotificationPrefs { rideUpdates: boolean; regroup: boolean }
export type NotificationCategory = 'ride_updates' | 'regroup';

export async function getPrefs(userId: string): Promise<NotificationPrefs> {
  const { rows } = await pool.query<{ ride_updates: boolean; regroup: boolean }>(
    `SELECT ride_updates, regroup FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );
  return rows[0] ? { rideUpdates: rows[0].ride_updates, regroup: rows[0].regroup } : { rideUpdates: true, regroup: true };
}

/** Partial upsert: omitted fields keep their value (default true when no row yet). */
export async function upsertPrefs(userId: string, p: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  const { rows } = await pool.query<{ ride_updates: boolean; regroup: boolean }>(
    `INSERT INTO notification_preferences (user_id, ride_updates, regroup)
     VALUES ($1, COALESCE($2::boolean, true), COALESCE($3::boolean, true))
     ON CONFLICT (user_id) DO UPDATE
       SET ride_updates = COALESCE($2::boolean, notification_preferences.ride_updates),
           regroup = COALESCE($3::boolean, notification_preferences.regroup),
           updated_at = now()
     RETURNING ride_updates, regroup`,
    [userId, p.rideUpdates ?? null, p.regroup ?? null]
  );
  return { rideUpdates: rows[0].ride_updates, regroup: rows[0].regroup };
}

/** Users among `userIds` who switched `category` off. */
export async function getDisabledUsers(userIds: string[], category: NotificationCategory): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const col = category === 'regroup' ? 'regroup' : 'ride_updates'; // fixed identifiers, never user input
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM notification_preferences WHERE user_id = ANY($1::text[]) AND ${col} = false`,
    [userIds]
  );
  return new Set(rows.map((r) => r.user_id));
}
