import { TrackPoint } from '../types';
import { LatLng, haversine } from '../utils/geo';

/** A departure from the planned route shorter than this is a wrong turn or a fuel-stop
 *  forecourt, not a different road worth following. */
export const MIN_DETOUR_METERS = 300;
/** Most via points kept; a route with more detours than this is mostly off-plan anyway. */
const MAX_VIA_POINTS = 8;

/**
 * One point at the middle of each stretch where the leader was off the planned route for at
 * least `minMeters` of riding. Routing a clone through these follows the roads that were ridden
 * where they differ from the plan, and the plan everywhere else.
 */
export function findDetourViaPoints(points: TrackPoint[], minMeters = MIN_DETOUR_METERS): LatLng[] {
  const via: LatLng[] = [];
  let stretch: TrackPoint[] = [];

  const close = () => {
    if (stretch.length >= 2) {
      let length = 0;
      for (let i = 1; i < stretch.length; i++) length += haversine(stretch[i - 1], stretch[i]);
      if (length >= minMeters) {
        // Midpoint by distance, not by index: fixes are denser where the leader rode slowly.
        let target = length / 2;
        let mid = stretch[stretch.length - 1];
        for (let i = 1; i < stretch.length; i++) {
          const d = haversine(stretch[i - 1], stretch[i]);
          if (target <= d) { mid = stretch[i]; break; }
          target -= d;
        }
        via.push({ lat: mid.lat, lng: mid.lng });
      }
    }
    stretch = [];
  };

  for (const p of points) {
    if (p.offRoute) stretch.push(p);
    else close();
  }
  close();

  return via.slice(0, MAX_VIA_POINTS);
}
