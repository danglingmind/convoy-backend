import { pool } from './pool';

export interface UserRow {
  id: string;
  name: string;
  avatar_url: string | null;
  username: string | null;
  phone: string | null;
  phone_visible: boolean;
  email_contact: string | null;
  email_contact_visible: boolean;
  notify_nearby_rides: boolean;
}

export interface ExtendedProfileFields {
  username?: string | null;
  phone?: string | null;
  phoneVisible?: boolean;
  emailContact?: string | null;
  emailContactVisible?: boolean;
  notifyNearbyRides?: boolean;
}

export async function upsertUser(
  id: string,
  name: string,
  avatarUrl: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, name, avatar_url, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
       SET avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url)`,
    [id, name, avatarUrl]
  );
}

export async function updateUserProfile(
  id: string,
  name: string,
  avatarUrl: string | null
): Promise<void> {
  await pool.query(
    `UPDATE users SET name = $2, avatar_url = COALESCE($3, avatar_url) WHERE id = $1`,
    [id, name, avatarUrl]
  );
}

export async function updateExtendedProfile(
  id: string,
  fields: ExtendedProfileFields
): Promise<{ usernameConflict: boolean }> {
  const setClauses: string[] = [];
  const params: unknown[] = [id];

  if (fields.username !== undefined) {
    params.push(fields.username === '' ? null : fields.username);
    setClauses.push(`username = $${params.length}`);
  }
  if (fields.phone !== undefined) {
    params.push(fields.phone);
    setClauses.push(`phone = $${params.length}`);
  }
  if (fields.phoneVisible !== undefined) {
    params.push(fields.phoneVisible);
    setClauses.push(`phone_visible = $${params.length}`);
  }
  if (fields.emailContact !== undefined) {
    params.push(fields.emailContact);
    setClauses.push(`email_contact = $${params.length}`);
  }
  if (fields.emailContactVisible !== undefined) {
    params.push(fields.emailContactVisible);
    setClauses.push(`email_contact_visible = $${params.length}`);
  }
  if (fields.notifyNearbyRides !== undefined) {
    params.push(fields.notifyNearbyRides);
    setClauses.push(`notify_nearby_rides = $${params.length}`);
  }

  if (setClauses.length === 0) return { usernameConflict: false };

  try {
    await pool.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $1`,
      params
    );
    return { usernameConflict: false };
  } catch (err: unknown) {
    // PostgreSQL unique_violation code = 23505
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === '23505'
    ) {
      return { usernameConflict: true };
    }
    throw err;
  }
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, name, avatar_url, username, phone, phone_visible,
            email_contact, email_contact_visible, notify_nearby_rides
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}
