import { Server } from 'socket.io';
import { ActiveRideState, OpenEmergency, OpenRegroup } from '../types';

interface BroadcastSlot {
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const slots = new Map<string, BroadcastSlot>();

export function buildStatePayload(state: ActiveRideState) {
  return {
    rideId: state.rideId,
    status: state.status,
    participants: Array.from(state.participants.values()).map((p) => ({
      userId: p.userId,
      lat: p.lat,
      lng: p.lng,
      speed: p.speed,
      heading: p.heading,
      progress: p.progress,
      offRoute: p.offRoute,
      updatedAt: p.updatedAt,
      battery: p.battery,
      signalStrength: p.signalStrength,
    })),
    leaderboard: state.leaderboard,
    // Arrays carry every open item. `openRegroup` / `openEmergency` (the most recent) stay for app
    // versions that predate multiple open items.
    openRegroups: Array.from(state.openRegroups.values()).map(publicRegroup),
    openEmergencies: Array.from(state.openEmergencies.values()).map(publicEmergency),
    openRegroup: lastOf(state.openRegroups, publicRegroup),
    openEmergency: lastOf(state.openEmergencies, publicEmergency),
  };
}

export function enqueueBroadcast(
  io: Server,
  rideId: string,
  getState: () => ActiveRideState | undefined
): void {
  const slot = slots.get(rideId) ?? { lastAt: 0, timer: null };

  if (slot.timer !== null) {
    // Already a pending broadcast — it will use the latest state when it fires
    slots.set(rideId, slot);
    return;
  }

  const now = Date.now();
  const delay = Math.max(0, 1000 - (now - slot.lastAt));

  slot.timer = setTimeout(() => {
    slot.timer = null;
    slot.lastAt = Date.now();
    slots.set(rideId, slot);

    const state = getState();
    if (state) {
      io.to(`ride:${rideId}`).emit('ride:state_update', buildStatePayload(state));
    }
  }, delay);

  slots.set(rideId, slot);
}

export function clearBroadcastSlot(rideId: string): void {
  const slot = slots.get(rideId);
  if (slot?.timer) clearTimeout(slot.timer);
  slots.delete(rideId);
}

function publicRegroup(r: OpenRegroup) {
  return {
    regroupId: r.regroupId,
    type: r.type,
    lat: r.lat,
    lng: r.lng,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

function publicEmergency(e: OpenEmergency) {
  return {
    emergencyId: e.emergencyId,
    userId: e.userId,
    lat: e.lat,
    lng: e.lng,
    message: e.message,
    createdAt: e.createdAt,
  };
}

function lastOf<T, R>(map: Map<string, T>, project: (v: T) => R): R | null {
  let last: T | undefined;
  for (const v of map.values()) last = v;
  return last === undefined ? null : project(last);
}
