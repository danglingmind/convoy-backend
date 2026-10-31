import { LatLng } from '../utils/geo';

const METERS_PER_DEG_LAT = 111_320;

/**
 * Douglas–Peucker line simplification. Distances are measured on a local equirectangular
 * projection (accurate to well under a metre at ride scale), and the stack is iterative so a
 * 10k-point track cannot overflow the call stack.
 */
export function simplifyTrack(points: LatLng[], toleranceMeters: number): LatLng[] {
  if (points.length <= 2) return points.slice();

  const cosLat = Math.cos((points[0].lat * Math.PI) / 180);
  const xs = points.map((p) => p.lng * METERS_PER_DEG_LAT * cosLat);
  const ys = points.map((p) => p.lat * METERS_PER_DEG_LAT);

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(xs[i], ys[i], xs[first], ys[first], xs[last], ys[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > toleranceMeters) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

function segmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
