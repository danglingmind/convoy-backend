import { Server } from 'socket.io';

/**
 * Heartbeat-driven presence.
 *
 * A user counts as "online" for a ride while the server has seen a signal from them
 * (a `ride:heartbeat`, a `ride:join`, or a `ride:location_update`) within PRESENCE_TTL_MS.
 *
 * This is deliberately DECOUPLED from raw socket connect/disconnect and from roster
 * membership (join/leave/ready). Socket liveness is unreliable on mobile — a locked or
 * backgrounded phone can keep a dead TCP socket alive for minutes, which made the old
 * join/leave-based dots stick green. With heartbeats, the client stops emitting the moment
 * it is backgrounded/locked/killed, so the TTL lapses and the user goes offline on its own.
 *
 * The server is the single source of truth: it broadcasts `ride:presence` snapshots
 * (`{ online: string[] }`) to the room whenever the online set changes.
 */

// Paired with the client's 5s heartbeat (RideRealtimeSession): a 15s TTL tolerates ~3 missed
// heartbeats, so brief mobile blips won't false-offline, while a real drop now reflects in
// ~15–18s (TTL + one sweep) instead of ~25s. (re)join still broadcasts presence immediately,
// so coming back online is instant.
const PRESENCE_TTL_MS = 15_000; // online if seen within this window
const SWEEP_MS = 3_000; // how often we re-evaluate + broadcast changes
const GC_MS = PRESENCE_TTL_MS * 3; // drop long-stale entries

// rideId -> (userId -> lastSeen epoch ms)
const presence = new Map<string, Map<string, number>>();
// rideId -> last broadcast online set (sorted, comma-joined) for change detection
const lastBroadcast = new Map<string, string>();

/** Record a liveness signal from a user for a ride. */
export function touchPresence(rideId: string, userId: string): void {
  let ride = presence.get(rideId);
  if (!ride) {
    ride = new Map();
    presence.set(rideId, ride);
  }
  ride.set(userId, Date.now());
}

/** Users seen within the TTL for a ride. */
export function onlineUserIds(rideId: string): string[] {
  const ride = presence.get(rideId);
  if (!ride) return [];
  const now = Date.now();
  const online: string[] = [];
  for (const [userId, lastSeen] of ride) {
    if (now - lastSeen <= PRESENCE_TTL_MS) online.push(userId);
  }
  return online;
}

function snapshotKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

/** Immediately broadcast the current online set for a ride (used on join for fast feedback). */
export function broadcastPresence(io: Server, rideId: string): void {
  const online = onlineUserIds(rideId);
  lastBroadcast.set(rideId, snapshotKey(online));
  io.to(`ride:${rideId}`).emit('ride:presence', { online });
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sweeper that expires stale presence and broadcasts changes. */
export function startPresenceSweeper(io: Server): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [rideId, ride] of presence) {
      // GC long-stale entries so the map doesn't grow unbounded.
      for (const [userId, lastSeen] of ride) {
        if (now - lastSeen > GC_MS) ride.delete(userId);
      }
      const online = onlineUserIds(rideId);
      const key = snapshotKey(online);
      if (key !== (lastBroadcast.get(rideId) ?? '')) {
        lastBroadcast.set(rideId, key);
        io.to(`ride:${rideId}`).emit('ride:presence', { online });
      }
      if (ride.size === 0) {
        presence.delete(rideId);
        lastBroadcast.delete(rideId);
      }
    }
  }, SWEEP_MS);
  sweeper.unref?.();
}
