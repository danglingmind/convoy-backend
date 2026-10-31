import { ActiveRideState, TrackPoint } from '../types';
import { insertTrackPoints, getTrackPoints, saveActualRoute } from '../db/trackRepo';
import { encodePolyline, computeCumulativeDist } from '../engines/polylineDecoder';
import { simplifyTrack } from '../engines/trackSimplifier';
import { haversine } from '../utils/geo';

/** A fix is kept only once the leader has moved this far from the last kept one. */
export const TRACK_MIN_SPACING_METERS = 20;
const FLUSH_EVERY_POINTS = 50;
const FLUSH_EVERY_MS = 30_000;
const SIMPLIFY_TOLERANCE_METERS = 8;
/** Fewer kept points than this is a ride that never went anywhere; leave the route unset. */
const MIN_TRACK_POINTS = 2;

/**
 * Records one leader fix. `deltaFromPrevFix` is the distance from the leader's previous fix
 * (already jitter/spike-guarded by the caller); the spacing check is against the last *kept*
 * point so slow riding still produces a point every 20 m.
 */
export function recordLeaderFix(
  state: ActiveRideState,
  point: { lat: number; lng: number },
  offRoute: boolean,
  deltaFromPrevFix: number | null,
  maxJumpMeters: number
): void {
  if (deltaFromPrevFix !== null && deltaFromPrevFix > maxJumpMeters) return; // GPS spike
  if (
    state.lastTrackPoint &&
    haversine(state.lastTrackPoint, point) < TRACK_MIN_SPACING_METERS
  ) {
    return;
  }
  state.trackBuffer.push({ lat: point.lat, lng: point.lng, offRoute });
  state.lastTrackPoint = point;

  if (
    state.trackBuffer.length >= FLUSH_EVERY_POINTS ||
    Date.now() - state.lastTrackFlushAt >= FLUSH_EVERY_MS
  ) {
    void flushTrackBuffer(state);
  }
}

/** Writes buffered fixes. On failure they go back on the front of the buffer for the next try. */
export async function flushTrackBuffer(state: ActiveRideState): Promise<void> {
  if (state.trackFlushing) return;
  if (state.trackBuffer.length === 0) {
    state.lastTrackFlushAt = Date.now();
    return;
  }
  state.trackFlushing = true;
  const batch: TrackPoint[] = state.trackBuffer.splice(0, state.trackBuffer.length);
  try {
    await insertTrackPoints(state.rideId, batch);
    state.lastTrackFlushAt = Date.now();
  } catch (err) {
    state.trackBuffer.unshift(...batch);
    console.error(`[track] flush failed rideId=${state.rideId}`, err);
  } finally {
    state.trackFlushing = false;
  }
}

/**
 * Condenses the stored track into rides.actual_route_polyline. Reads from the database, not
 * memory, so it works after a server restart. Returns the ridden distance, or null when there
 * was no usable track. Never throws: a failure here must not fail ending the ride.
 */
export async function finalizeLeaderTrack(
  rideId: string,
  state?: ActiveRideState
): Promise<number | null> {
  try {
    if (state) {
      // A flush may be in flight; wait it out so its points are in the table before we read.
      for (let i = 0; i < 20 && state.trackFlushing; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await flushTrackBuffer(state);
    }
    const points = await getTrackPoints(rideId);
    if (points.length < MIN_TRACK_POINTS) return null;

    const simplified = simplifyTrack(points, SIMPLIFY_TOLERANCE_METERS);
    const cum = computeCumulativeDist(points);
    const distanceMeters = cum[cum.length - 1];
    await saveActualRoute(rideId, encodePolyline(simplified), distanceMeters);
    return distanceMeters;
  } catch (err) {
    console.error(`[track] finalize failed rideId=${rideId}`, err);
    return null;
  }
}
