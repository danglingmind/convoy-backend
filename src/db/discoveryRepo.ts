import { pool } from './pool';

export interface NearbyRideRow {
  id: string;
  title: string;
  status: string;
  destination_name: string;
  distance_meters: number;
  start_lat: number;
  start_lng: number;
  distance_from_user_km: number;
  rider_count: number;
  max_participants: number;
  leader_name: string;
  leader_id: string;
  invite_code: string;
}

export async function getNearbyRides(
  userId: string,
  lat: number,
  lng: number,
  radiusKm: number
): Promise<NearbyRideRow[]> {
  const { rows } = await pool.query<NearbyRideRow>(
    `SELECT * FROM (
      SELECT
        r.id,
        r.title,
        r.status,
        r.destination_name,
        r.distance_meters,
        r.max_allowed_participants AS max_participants,
        r.invite_code,
        r.leader_id,
        w.lat  AS start_lat,
        w.lng  AS start_lng,
        u.name AS leader_name,
        COUNT(rp.id) FILTER (WHERE rp.status NOT IN ('LEFT')) AS rider_count,
        6371 * 2 * ASIN(SQRT(
          POWER(SIN(RADIANS((w.lat - $2) / 2)), 2) +
          COS(RADIANS($2)) * COS(RADIANS(w.lat)) *
          POWER(SIN(RADIANS((w.lng - $3) / 2)), 2)
        )) AS distance_from_user_km
      FROM rides r
      JOIN ride_waypoints w ON w.ride_id = r.id AND w.type = 'START'
      JOIN users u ON u.id = r.leader_id
      LEFT JOIN ride_participants rp ON rp.ride_id = r.id
      WHERE r.status IN ('LOBBY', 'IN_PROGRESS')
        AND r.ended_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ride_participants
          WHERE ride_id = r.id
            AND user_id = $1
            AND status NOT IN ('LEFT')
        )
      GROUP BY r.id, w.lat, w.lng, u.name, u.id
    ) sub
    WHERE distance_from_user_km <= $4
    ORDER BY distance_from_user_km ASC
    LIMIT 20`,
    [userId, lat, lng, radiusKm]
  );
  return rows;
}
