import { LatLng, haversine } from '../utils/geo';
import { decodePolyline, encodePolyline } from './polylineDecoder';

/** How much of a shared route's start is withheld. A ride usually begins at the leader's front
 *  door, and the first stretch of road would give it away. */
export const START_TRIM_METERS = 500;

/** Removes the first `meters` of a route. Null when nothing useful is left. */
export function trimStart(points: LatLng[], meters: number): LatLng[] | null {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    travelled += haversine(points[i - 1], points[i]);
    if (travelled >= meters) {
      const rest = points.slice(i);
      return rest.length >= 2 ? rest : null;
    }
  }
  return null;
}

/** Removes the last `meters` of a route. Null when nothing useful is left. */
export function trimEnd(points: LatLng[], meters: number): LatLng[] | null {
  const reversed = trimStart(points.slice().reverse(), meters);
  return reversed ? reversed.reverse() : null;
}

/** Public form of a stored polyline: start withheld. */
export function publicPolyline(encoded: string | null): string | null {
  if (!encoded) return null;
  const trimmed = trimStart(decodePolyline(encoded), START_TRIM_METERS);
  return trimmed ? encodePolyline(trimmed) : null;
}

/** Public form of the ridden route: start withheld, and the end too unless it finished at the
 *  destination (a place the leader chose to share, not somewhere they stopped by chance). */
export function publicActualPolyline(encoded: string | null, destination: LatLng): string | null {
  if (!encoded) return null;
  const points = decodePolyline(encoded);
  let out = trimStart(points, START_TRIM_METERS);
  if (out && haversine(out[out.length - 1], destination) > 1000) {
    out = trimEnd(out, START_TRIM_METERS);
  }
  return out ? encodePolyline(out) : null;
}

/** True when a point is inside the withheld start zone. */
export function nearStart(point: LatLng, start: LatLng | null): boolean {
  return start !== null && haversine(point, start) < START_TRIM_METERS;
}
