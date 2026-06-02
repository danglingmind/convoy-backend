import { LatLng, haversine } from '../utils/geo';

const OFF_ROUTE_THRESHOLD = parseInt(
  process.env.OFF_ROUTE_THRESHOLD_METERS ?? '75',
  10
);

export interface ProgressResult {
  progress: number;
  offRoute: boolean;
}

export function computeProgress(
  rider: LatLng,
  routePoints: LatLng[],
  cumulativeDist: number[]
): ProgressResult {
  if (routePoints.length < 2) {
    return { progress: 0, offRoute: false };
  }

  let minDist = Infinity;
  let bestProgress = 0;

  for (let i = 0; i < routePoints.length - 1; i++) {
    const A = routePoints[i];
    const B = routePoints[i + 1];

    const ABx = B.lng - A.lng;
    const ABy = B.lat - A.lat;
    const APx = rider.lng - A.lng;
    const APy = rider.lat - A.lat;

    const abDot = ABx * ABx + ABy * ABy;
    let t = abDot > 0 ? (APx * ABx + APy * ABy) / abDot : 0;
    t = Math.max(0, Math.min(1, t));

    const projected: LatLng = {
      lat: A.lat + t * ABy,
      lng: A.lng + t * ABx,
    };

    const dist = haversine(rider, projected);

    if (dist < minDist) {
      minDist = dist;
      const segLen = haversine(A, B);
      bestProgress = cumulativeDist[i] + t * segLen;
    }
  }

  return {
    progress: bestProgress,
    offRoute: minDist > OFF_ROUTE_THRESHOLD,
  };
}
