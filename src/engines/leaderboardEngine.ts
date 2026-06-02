import { ActiveRideState, LeaderboardEntry } from '../types';

const SPLIT_THRESHOLD = parseInt(
  process.env.SPLIT_THRESHOLD_METERS ?? '5000',
  10
);

export function runLeaderboardEngine(state: ActiveRideState): void {
  const previousRanks = new Map<string, number>();
  for (const entry of state.leaderboard) {
    previousRanks.set(entry.userId, entry.rank);
  }

  const active = Array.from(state.participants.values()).filter(
    (p) => p.status === 'ACTIVE' || p.status === 'READY'
  );

  active.sort((a, b) => b.progress - a.progress);

  if (active.length === 0) {
    state.leaderboard = [];
    return;
  }

  const leaderProgress = active[0].progress;
  const lastProgress = active[active.length - 1].progress;
  const maxGap = leaderProgress - lastProgress;

  // Compactness sample
  if (state.distanceMeters > 0) {
    state.spreadSampleSum +=
      1 - Math.min(maxGap, state.distanceMeters) / state.distanceMeters;
    state.spreadSampleCount++;
  }

  // Split detection
  const splitNow = active.length >= 2 && maxGap > SPLIT_THRESHOLD;
  state.splitActive = splitNow;

  const leaderboard: LeaderboardEntry[] = [];

  for (let i = 0; i < active.length; i++) {
    const p = active[i];
    const rank = i + 1;
    const gapMeters = Math.max(0, leaderProgress - p.progress);
    const prevRank = previousRanks.get(p.userId);
    const positionDelta = prevRank !== undefined ? prevRank - rank : 0;

    // Accumulate gap for sync score
    const acc = state.perRiderGapAccumulator.get(p.userId) ?? {
      gapSum: 0,
      gapCount: 0,
    };
    acc.gapSum += gapMeters;
    acc.gapCount++;
    state.perRiderGapAccumulator.set(p.userId, acc);

    leaderboard.push({
      rank,
      userId: p.userId,
      name: p.name,
      progress: p.progress,
      gapMeters,
      positionDelta,
      title: null,
    });
  }

  state.leaderboard = leaderboard;
}
