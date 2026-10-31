import { LatLng, haversine } from '../utils/geo';

export function decodePolyline(encoded: string): LatLng[] {
  const result: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let value = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      value |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = value & 1 ? ~(value >> 1) : value >> 1;
    lat += dlat;

    shift = 0;
    value = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      value |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = value & 1 ? ~(value >> 1) : value >> 1;
    lng += dlng;

    result.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return result;
}

export function computeCumulativeDist(points: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  }
  return cum;
}

function encodeValue(value: number, out: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1;
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  out.push(String.fromCharCode(v + 63));
}

/** Google encoded polyline (precision 5), the inverse of decodePolyline. */
export function encodePolyline(points: LatLng[]): string {
  const out: string[] = [];
  let prevLat = 0;
  let prevLng = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    encodeValue(lat - prevLat, out);
    encodeValue(lng - prevLng, out);
    prevLat = lat;
    prevLng = lng;
  }
  return out.join('');
}
