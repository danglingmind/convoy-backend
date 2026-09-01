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

export interface AccountRideIds {
  /** Rides this user leads. Deleting the account deletes these outright. */
  led: string[];
  /** Rides they merely joined. Those survive; only their participation goes. */
  joined: string[];
}

/**
 * The rides an account touches, read before it is deleted so the sockets can be told afterwards.
 *
 * Split by role because the two need opposite broadcasts: a led ride disappears for everyone in
 * it (`ride:deleted`), while a joined ride carries on one rider lighter
 * (`ride:participant_left`).
 */
export async function getAccountRideIds(userId: string): Promise<AccountRideIds> {
  const [led, joined] = await Promise.all([
    pool.query<{ id: string }>('SELECT id FROM rides WHERE leader_id = $1', [userId]),
    pool.query<{ ride_id: string }>(
      `SELECT rp.ride_id
         FROM ride_participants rp
         JOIN rides r ON r.id = rp.ride_id
        WHERE rp.user_id = $1 AND r.leader_id <> $1`,
      [userId]
    ),
  ]);
  return {
    led: led.rows.map((r) => r.id),
    joined: joined.rows.map((r) => r.ride_id),
  };
}

export interface AccountDeletionCounts {
  ledRides: number;
  participations: number;
  memberships: number;
}

/**
 * Erases a user and everything belonging to them, in one transaction.
 *
 * Google Play's account deletion policy requires the data to be gone, not flagged, frozen or
 * anonymised — so this is a hard delete, and it is deliberately less forgiving than [deleteRide],
 * which refuses COMPLETED rides because their `ride_summaries` row has no ON DELETE CASCADE. An
 * account deletion cannot make that exception, so the summaries are deleted explicitly first.
 *
 * Nothing cascades from `users`: all five foreign keys into it are plain REFERENCES. The order
 * below is therefore not stylistic, it is the only order the constraints permit —
 *
 *   1. summaries of the rides they lead   (no cascade from rides)
 *   2. the rides they lead                (cascades waypoints, participants, regroups,
 *                                          emergencies on those rides, including other people's)
 *   3. their participations elsewhere     (ride_participants.user_id)
 *   4. regroups they called elsewhere     (regroup_events.created_by)
 *   5. emergencies they raised elsewhere  (emergency_events.user_id)
 *   6. their memberships                  (user_memberships.user_id)
 *   7. the user row
 *
 * Steps 4 and 5 exist only for rides someone else leads; the ones in their own rides went with
 * step 2. Missing either leaves a foreign key pointing at a row step 7 is about to remove, and
 * the whole transaction rolls back.
 *
 * Deleting a ride they lead takes it away from everyone in it. That is intended, and the client
 * says so before it asks for confirmation: a ride whose leader is gone cannot be started, ended
 * or edited by anybody.
 */
export async function deleteUserAccount(userId: string): Promise<AccountDeletionCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: led } = await client.query<{ id: string }>(
      'SELECT id FROM rides WHERE leader_id = $1 FOR UPDATE',
      [userId]
    );
    const ledIds = led.map((r) => r.id);

    if (ledIds.length > 0) {
      await client.query('DELETE FROM ride_summaries WHERE ride_id = ANY($1::uuid[])', [ledIds]);
      await client.query('DELETE FROM rides WHERE id = ANY($1::uuid[])', [ledIds]);
    }

    const participations = await client.query(
      'DELETE FROM ride_participants WHERE user_id = $1',
      [userId]
    );
    await client.query('DELETE FROM regroup_events WHERE created_by = $1', [userId]);
    await client.query('DELETE FROM emergency_events WHERE user_id = $1', [userId]);
    const memberships = await client.query(
      'DELETE FROM user_memberships WHERE user_id = $1',
      [userId]
    );
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');

    return {
      ledRides: ledIds.length,
      participations: participations.rowCount ?? 0,
      memberships: memberships.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
