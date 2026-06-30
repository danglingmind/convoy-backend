import { ActiveRideState, RideTitle } from '../types';
import { createSummary } from '../db/summaryRepo';
import {
  updateParticipantTitle,
  updateParticipantSyncScore,
  getParticipantsWithUsers,
} from '../db/participantRepo';
import { countRegroupEvents } from '../db/regroupRepo';
import { countEmergencyEvents } from '../db/emergencyRepo';

// Called when the ride's in-memory state was lost (e.g. server restart).
// Produces a minimal summary from persisted DB data so the ride appears in history.
export async function generateFallbackSummary(
  rideId: string,
  leaderId: string,
  startedAt: Date,
  endedAt: Date,
  distanceMeters: number,
  estimatedDurationSeconds?: number
): Promise<void> {
  const durationSeconds = estimatedDurationSeconds ?? Math.round(
    (endedAt.getTime() - startedAt.getTime()) / 1000
  );
  const avgSpeedKmh =
    durationSeconds > 0 ? (distanceMeters / durationSeconds) * 3.6 : null;

  const [totalRegroups, totalEmergencies] = await Promise.all([
    countRegroupEvents(rideId),
    countEmergencyEvents(rideId),
  ]);

  await createSummary({
    rideId,
    durationSeconds,
    distanceMeters,
    avgSpeedKmh,
    maxGroupSplitMeters: 0,
    compactnessScore: 1.0,
    totalRegroups,
    totalEmergencies,
  });

  // Assign RIDE_LEADER title; others stay null (no GPS telemetry available)
  await updateParticipantTitle(rideId, leaderId, 'RIDE_LEADER');
}

export async function generateRideSummary(
  rideId: string,
  startedAt: Date,
  endedAt: Date,
  state: ActiveRideState,
  estimatedDurationSeconds?: number
): Promise<void> {
  const durationSeconds = estimatedDurationSeconds ?? Math.round(
    (endedAt.getTime() - startedAt.getTime()) / 1000
  );
  const distanceMeters = state.distanceMeters;
  const avgSpeedKmh =
    durationSeconds > 0
      ? (distanceMeters / durationSeconds) * 3.6
      : null;

  const compactnessScore =
    state.spreadSampleCount > 0
      ? state.spreadSampleSum / state.spreadSampleCount
      : 1.0;

  // Max split ever seen — track via leaderboard entries
  const maxGroupSplitMeters = Math.max(
    0,
    ...state.leaderboard.map((e) => e.gapMeters)
  );

  const totalRegroups = await countRegroupEvents(rideId);
  const totalEmergencies = await countEmergencyEvents(rideId);

  await createSummary({
    rideId,
    durationSeconds,
    distanceMeters,
    avgSpeedKmh,
    maxGroupSplitMeters,
    compactnessScore,
    totalRegroups,
    totalEmergencies,
  });

  await assignTitles(rideId, state);
  await assignSyncScores(rideId, state);
}

async function assignTitles(
  rideId: string,
  state: ActiveRideState
): Promise<void> {
  const participants = await getParticipantsWithUsers(rideId);
  const active = participants.filter((p) => p.status !== 'LEFT');

  // Leader always gets RIDE_LEADER
  await updateParticipantTitle(rideId, state.leaderId, 'RIDE_LEADER');

  const nonLeaders = active.filter((p) => p.user_id !== state.leaderId);

  if (nonLeaders.length === 0) return;

  // PACE_KEEPER: lowest avgGap excluding leader (tie: earliest joined_at)
  let paceKeeperId: string | null = null;
  let lowestAvgGap = Infinity;
  for (const p of nonLeaders) {
    const acc = state.perRiderGapAccumulator.get(p.user_id);
    const avgGap = acc && acc.gapCount > 0 ? acc.gapSum / acc.gapCount : Infinity;
    if (
      avgGap < lowestAvgGap ||
      (avgGap === lowestAvgGap &&
        paceKeeperId !== null &&
        p.joined_at <
          active.find((a) => a.user_id === paceKeeperId)!.joined_at)
    ) {
      lowestAvgGap = avgGap;
      paceKeeperId = p.user_id;
    }
  }

  // TRAIL_GUARDIAN: lowest final progress excluding leader (tie: lowest progress wins → first by sort)
  const byProgress = [...nonLeaders].sort((a, b) => {
    const pa =
      state.participants.get(a.user_id)?.progress ?? 0;
    const pb =
      state.participants.get(b.user_id)?.progress ?? 0;
    return pa - pb;
  });
  const trailGuardianId =
    byProgress.length > 0 ? byProgress[0].user_id : null;

  for (const p of nonLeaders) {
    let title: RideTitle;
    if (p.user_id === paceKeeperId) {
      title = 'PACE_KEEPER';
    } else if (p.user_id === trailGuardianId) {
      title = 'TRAIL_GUARDIAN';
    } else {
      title = 'FORMATION_RIDER';
    }
    await updateParticipantTitle(rideId, p.user_id, title);
  }
}

async function assignSyncScores(
  rideId: string,
  state: ActiveRideState
): Promise<void> {
  const distanceMeters = state.distanceMeters;

  // Leader always 100
  await updateParticipantSyncScore(rideId, state.leaderId, 100);

  for (const [userId, acc] of state.perRiderGapAccumulator) {
    if (userId === state.leaderId) continue;
    const avgGap = acc.gapCount > 0 ? acc.gapSum / acc.gapCount : 0;
    const raw =
      distanceMeters > 0
        ? Math.round((1 - avgGap / distanceMeters) * 100)
        : 100;
    const score = Math.max(0, Math.min(100, raw));
    await updateParticipantSyncScore(rideId, userId, score);
  }
}
