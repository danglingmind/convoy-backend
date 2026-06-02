import { PoolClient } from 'pg';
import { pool } from './pool';
import { ParticipantStatus, RideTitle } from '../types';

export interface ParticipantRow {
  id: string;
  ride_id: string;
  user_id: string;
  status: ParticipantStatus;
  counted_toward_quota: boolean;
  quota_consumed_at: Date | null;
  ride_title: RideTitle | null;
  sync_score: number | null;
  joined_at: Date;
}

export interface ParticipantWithUser extends ParticipantRow {
  name: string;
  avatar_url: string | null;
}

export async function addParticipant(
  rideId: string,
  userId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO ride_participants (ride_id, user_id) VALUES ($1, $2)`,
    [rideId, userId]
  );
}

export async function getParticipant(
  rideId: string,
  userId: string
): Promise<ParticipantRow | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT * FROM ride_participants WHERE ride_id = $1 AND user_id = $2`,
    [rideId, userId]
  );
  return rows[0] ?? null;
}

export async function getParticipantsWithUsers(
  rideId: string
): Promise<ParticipantWithUser[]> {
  const { rows } = await pool.query<ParticipantWithUser>(
    `SELECT rp.*, u.name, u.avatar_url
     FROM ride_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.ride_id = $1
     ORDER BY rp.joined_at`,
    [rideId]
  );
  return rows;
}

export async function getActiveParticipantsWithUsers(
  rideId: string
): Promise<ParticipantWithUser[]> {
  const { rows } = await pool.query<ParticipantWithUser>(
    `SELECT rp.*, u.name, u.avatar_url
     FROM ride_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.ride_id = $1 AND rp.status != 'LEFT'
     ORDER BY rp.joined_at`,
    [rideId]
  );
  return rows;
}

export async function countActiveParticipants(rideId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ride_participants
     WHERE ride_id = $1 AND status != 'LEFT'`,
    [rideId]
  );
  return parseInt(rows[0].count, 10);
}

export async function updateParticipantStatus(
  rideId: string,
  userId: string,
  status: ParticipantStatus
): Promise<void> {
  await pool.query(
    `UPDATE ride_participants SET status = $1 WHERE ride_id = $2 AND user_id = $3`,
    [status, rideId, userId]
  );
}

export async function markQuotaConsumed(
  rideId: string,
  client?: PoolClient
): Promise<void> {
  const q = client ?? pool;
  await q.query(
    `UPDATE ride_participants
     SET counted_toward_quota = true, quota_consumed_at = now()
     WHERE ride_id = $1 AND status IN ('JOINED', 'READY')`,
    [rideId]
  );
}

export async function updateParticipantTitle(
  rideId: string,
  userId: string,
  title: RideTitle
): Promise<void> {
  await pool.query(
    `UPDATE ride_participants SET ride_title = $1 WHERE ride_id = $2 AND user_id = $3`,
    [title, rideId, userId]
  );
}

export async function updateParticipantSyncScore(
  rideId: string,
  userId: string,
  score: number
): Promise<void> {
  await pool.query(
    `UPDATE ride_participants SET sync_score = $1 WHERE ride_id = $2 AND user_id = $3`,
    [score, rideId, userId]
  );
}
