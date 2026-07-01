import { PoolClient } from 'pg';
import { pool } from './pool';
import { RideStatus, WaypointType } from '../types';

export interface WaypointInput {
  order: number;
  name: string;
  lat: number;
  lng: number;
  type: WaypointType;
}

export interface CreateRideInput {
  title: string;
  destinationName: string;
  destinationLat: number;
  destinationLng: number;
  routePolyline: string;
  distanceMeters: number;
  estimatedDurationSeconds: number;
  maxAllowedParticipants: number;
  membershipSnapshot: { monthlyLimit: number | null; maxRidersPerRide: number };
  waypoints: WaypointInput[];
}

export interface RideRow {
  id: string;
  title: string;
  status: RideStatus;
  leader_id: string;
  invite_code: string;
  destination_name: string;
  destination_lat: number;
  destination_lng: number;
  distance_meters: number;
  estimated_duration_seconds: number;
  max_allowed_participants: number;
  membership_snapshot: { monthlyLimit: number | null; maxRidersPerRide: number };
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

export interface RideRowWithPolyline extends RideRow {
  route_polyline: string;
}

export interface WaypointRow {
  id: string;
  order: number;
  name: string;
  lat: number;
  lng: number;
  type: WaypointType;
}

export async function createRide(
  leaderId: string,
  input: CreateRideInput,
  inviteCode: string
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO rides
         (title, leader_id, invite_code, destination_name, destination_lat, destination_lng,
          route_polyline, distance_meters, estimated_duration_seconds,
          max_allowed_participants, membership_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.title,
        leaderId,
        inviteCode,
        input.destinationName,
        input.destinationLat,
        input.destinationLng,
        input.routePolyline,
        input.distanceMeters,
        input.estimatedDurationSeconds,
        input.maxAllowedParticipants,
        JSON.stringify(input.membershipSnapshot),
      ]
    );

    const rideId = rows[0].id;

    for (const wp of input.waypoints) {
      await client.query(
        `INSERT INTO ride_waypoints (ride_id, "order", name, lat, lng, type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rideId, wp.order, wp.name, wp.lat, wp.lng, wp.type]
      );
    }

    await client.query('COMMIT');
    return rideId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getRideById(id: string): Promise<RideRow | null> {
  const { rows } = await pool.query<RideRow>(
    `SELECT id, title, status, leader_id, invite_code,
            destination_name, destination_lat, destination_lng,
            distance_meters, estimated_duration_seconds, max_allowed_participants,
            membership_snapshot, started_at, ended_at, created_at
     FROM rides WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getRideWithPolyline(
  id: string
): Promise<RideRowWithPolyline | null> {
  const { rows } = await pool.query<RideRowWithPolyline>(
    `SELECT id, title, status, leader_id, invite_code,
            destination_name, destination_lat, destination_lng,
            route_polyline, distance_meters, estimated_duration_seconds,
            max_allowed_participants, membership_snapshot,
            started_at, ended_at, created_at
     FROM rides WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getRideByInviteCode(inviteCode: string): Promise<
  | {
      id: string;
      title: string;
      leaderName: string;
      participantCount: number;
      maxParticipants: number;
      status: RideStatus;
    }
  | null
> {
  const { rows } = await pool.query(
    `SELECT r.id, r.title, r.status, r.max_allowed_participants,
            u.name AS leader_name,
            COUNT(rp.id) FILTER (WHERE rp.status != 'LEFT') AS participant_count
     FROM rides r
     JOIN users u ON u.id = r.leader_id
     LEFT JOIN ride_participants rp ON rp.ride_id = r.id
     WHERE r.invite_code = $1
     GROUP BY r.id, u.name`,
    [inviteCode]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    title: row.title,
    leaderName: row.leader_name,
    participantCount: parseInt(row.participant_count, 10),
    maxParticipants: row.max_allowed_participants,
    status: row.status,
  };
}

export async function getWaypoints(rideId: string): Promise<WaypointRow[]> {
  const { rows } = await pool.query<WaypointRow>(
    `SELECT id, "order", name, lat, lng, type
     FROM ride_waypoints
     WHERE ride_id = $1
     ORDER BY "order"`,
    [rideId]
  );
  return rows;
}

export interface UpdateRideInput {
  title: string;
  destinationName: string;
  destinationLat: number;
  destinationLng: number;
  routePolyline: string;
  distanceMeters: number;
  estimatedDurationSeconds: number;
  maxAllowedParticipants: number;
  waypoints: WaypointInput[];
}

export async function updateRide(rideId: string, input: UpdateRideInput): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE rides
         SET title = $1, destination_name = $2, destination_lat = $3, destination_lng = $4,
             route_polyline = $5, distance_meters = $6, estimated_duration_seconds = $7,
             max_allowed_participants = $8
       WHERE id = $9`,
      [
        input.title, input.destinationName, input.destinationLat, input.destinationLng,
        input.routePolyline, input.distanceMeters, input.estimatedDurationSeconds,
        input.maxAllowedParticipants, rideId,
      ]
    );
    await client.query('DELETE FROM ride_waypoints WHERE ride_id = $1', [rideId]);
    for (const wp of input.waypoints) {
      await client.query(
        `INSERT INTO ride_waypoints (ride_id, "order", name, lat, lng, type) VALUES ($1,$2,$3,$4,$5,$6)`,
        [rideId, wp.order, wp.name, wp.lat, wp.lng, wp.type]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateRideStatus(
  id: string,
  status: RideStatus,
  extra: { started_at?: Date | null; ended_at?: Date | null } = {},
  client?: PoolClient
): Promise<void> {
  const q = client ?? pool;
  if (extra.started_at !== undefined) {
    await q.query(
      `UPDATE rides SET status = $1, started_at = $2 WHERE id = $3`,
      [status, extra.started_at, id]
    );
  } else if (extra.ended_at !== undefined) {
    await q.query(
      `UPDATE rides SET status = $1, ended_at = $2 WHERE id = $3`,
      [status, extra.ended_at, id]
    );
  } else {
    await q.query(`UPDATE rides SET status = $1 WHERE id = $2`, [status, id]);
  }
}
