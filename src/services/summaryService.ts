import { ActiveRideState, RideTitle } from '../types';
import { createSummary } from '../db/summaryRepo';
import {
  updateParticipantTitle,
  updateParticipantSyncScore,
  getParticipantsWithUsers,
} from '../db/participantRepo';
import { countRegroupEvents } from '../db/regroupRepo';
import { countEmergencyEvents } from '../db/emergencyRepo';

// Below this much sampled moving time we don't trust it as a speed basis and fall back to
// wall-clock, rather than dividing a real distance by a couple of stray seconds.
const MIN_MOVING_SECONDS = 30;
// Sanity ceiling for a reported average. Above this the inputs disagree (typically the
// planned route distance paired with a ride that ended almost immediately), and a wrong
// number stated confidently is worse than no number.
const MAX_PLAUSIBLE_AVG_KMH = 200;

/**
 * Average speed for the summary, or null when the inputs can't support one.
 *
 * Returning null matters: the clients render null as "--" but render 0 as a claim that the
 * ride averaged 0 km/h, which is what produced the bogus zero on real rides.
 */
function averageSpeedKmh(distanceMeters: number, seconds: number): number | null {
  if (distanceMeters <= 0 || seconds <= 0) return null;
  const kmh = (distanceMeters / seconds) * 3.6;
  if (!Number.isFinite(kmh) || kmh > MAX_PLAUSIBLE_AVG_KMH) return null;
  return kmh;
}

// Called when the ride's in-memory state was lost (e.g. server restart).
// Produces a minimal summary from persisted DB data so the ride appears in history.
export async function generateFallbackSummary(
  rideId: string,
  leaderId: string,
  startedAt: Date,
  endedAt: Date,
  distanceMeters: number
): Promise<void> {
  // No in-memory telemetry survives here, so distance stays the planned route,
  // but duration is still the actual wall-clock span rather than the planned ETA.
  const durationSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
  );
  // No telemetry survived, so there is no moving time to divide by — wall-clock is all we have.
  // Note this pairs the PLANNED distance with the ACTUAL duration, so the plausibility guard in
  // averageSpeedKmh is doing real work here: a ride abandoned after a minute would otherwise
  // report the whole planned route covered in that minute.
  const avgSpeedKmh = averageSpeedKmh(distanceMeters, durationSeconds);

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
  state: ActiveRideState
): Promise<void> {
  // Actual wall-clock ride duration, not the planned ETA. (Includes any paused
  // time — the ride state does not yet track pause spans separately.)
  const durationSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
  );

  // Actual distance ridden by the leader = route-snapped progress + off-route
  // detours. Fall back to the planned route distance only if no GPS was ever
  // received (e.g. the leader never sent a location update).
  // Preferred: snapped progress + filtered off-route detours. Then raw leader GPS distance,
  // which covers rides where snapped progress never advanced (fixes that never projected onto
  // the route, a malformed polyline) — those used to fall straight through to the planned
  // distance, or to 0 when the ride was created with distanceMeters: 0. Planned distance is the
  // last resort, and 0 is now allowed to mean "unknown" rather than "stood still".
  const traveled = state.maxLeaderProgress + state.detourMeters;
  const distanceMeters = Math.round(
    traveled > 0
      ? traveled
      : state.leaderRawMeters > 0
        ? state.leaderRawMeters
        : state.distanceMeters
  );

  // Moving average: distance over time actually spent riding. Wall-clock duration includes
  // every traffic light, fuel stop and regroup wait, which dragged the figure well below what
  // riders saw on their speedo. Falls back to wall-clock when too little moving time was
  // sampled to be trustworthy (a very short ride, or sparse fixes).
  const movingSeconds = Math.round(state.movingSeconds);
  const speedBasisSeconds =
    movingSeconds >= MIN_MOVING_SECONDS ? movingSeconds : durationSeconds;
  const avgSpeedKmh = averageSpeedKmh(distanceMeters, speedBasisSeconds);

  const compactnessScore =
    state.spreadSampleCount > 0
      ? state.spreadSampleSum / state.spreadSampleCount
      : 1.0;

  // Largest leader-to-tail gap observed at any point during the ride.
  const maxGroupSplitMeters = state.maxGroupSplitMeters;

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
