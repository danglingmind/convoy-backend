import { pool } from './pool';

export interface SummaryInput {
  rideId: string;
  durationSeconds: number;
  distanceMeters: number;
  avgSpeedKmh: number | null;
  maxGroupSplitMeters: number;
  compactnessScore: number;
  totalRegroups: number;
  totalEmergencies: number;
}

export async function createSummary(input: SummaryInput): Promise<void> {
  await pool.query(
    `INSERT INTO ride_summaries
       (ride_id, duration_seconds, distance_meters, avg_speed_kmh,
        max_group_split_meters, compactness_score, total_regroups, total_emergencies)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.rideId,
      input.durationSeconds,
      input.distanceMeters,
      input.avgSpeedKmh,
      input.maxGroupSplitMeters,
      input.compactnessScore,
      input.totalRegroups,
      input.totalEmergencies,
    ]
  );
}

export async function getSummaryWithParticipants(rideId: string): Promise<{
  summary: {
    rideId: string;
    durationSeconds: number;
    distanceMeters: number;
    avgSpeedKmh: number | null;
    maxGroupSplitMeters: number;
    compactnessScore: number;
    totalRegroups: number;
    totalEmergencies: number;
    createdAt: Date;
  };
  participants: {
    userId: string;
    name: string;
    avatarUrl: string | null;
    rideTitle: string | null;
    syncScore: number | null;
  }[];
} | null> {
  const summaryRes = await pool.query(
    `SELECT rs.*, r.status
     FROM ride_summaries rs
     JOIN rides r ON r.id = rs.ride_id
     WHERE rs.ride_id = $1`,
    [rideId]
  );

  if (!summaryRes.rows[0]) return null;
  const s = summaryRes.rows[0];

  const participantsRes = await pool.query(
    `SELECT rp.user_id, u.name, u.avatar_url, rp.ride_title, rp.sync_score
     FROM ride_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.ride_id = $1 AND rp.status != 'LEFT'
     ORDER BY rp.joined_at`,
    [rideId]
  );

  return {
    summary: {
      rideId: s.ride_id,
      durationSeconds: s.duration_seconds,
      distanceMeters: s.distance_meters,
      avgSpeedKmh: s.avg_speed_kmh,
      maxGroupSplitMeters: s.max_group_split_meters,
      compactnessScore: s.compactness_score,
      totalRegroups: s.total_regroups,
      totalEmergencies: s.total_emergencies,
      createdAt: s.created_at,
    },
    participants: participantsRes.rows.map((p) => ({
      userId: p.user_id,
      name: p.name,
      avatarUrl: p.avatar_url,
      rideTitle: p.ride_title,
      syncScore: p.sync_score,
    })),
  };
}
