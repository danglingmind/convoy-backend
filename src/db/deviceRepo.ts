import { pool } from './pool';

export type DevicePlatform = 'ios' | 'android';

export interface DeviceRow {
  user_id: string;
  platform: DevicePlatform;
  token: string;
}

/** Upsert by token; a token already held by another user moves to the caller. */
export async function upsertDevice(
  userId: string,
  token: string,
  platform: DevicePlatform,
  locale?: string,
  appVersion?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO device_tokens (user_id, platform, token, locale, app_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
           locale = EXCLUDED.locale, app_version = EXCLUDED.app_version, updated_at = now()`,
    [userId, platform, token, locale ?? null, appVersion ?? null]
  );
}

export async function deleteDevice(userId: string, token: string): Promise<void> {
  await pool.query(`DELETE FROM device_tokens WHERE token = $1 AND user_id = $2`, [token, userId]);
}

/** Remove a token the push service reported dead (any owner). */
export async function deleteDeadToken(token: string): Promise<void> {
  await pool.query(`DELETE FROM device_tokens WHERE token = $1`, [token]);
}

export async function getDevicesForUsers(userIds: string[]): Promise<DeviceRow[]> {
  if (userIds.length === 0) return [];
  const { rows } = await pool.query<DeviceRow>(
    `SELECT user_id, platform, token FROM device_tokens WHERE user_id = ANY($1::text[])`,
    [userIds]
  );
  return rows;
}
