import { Server, Socket } from 'socket.io';
import { rideStore } from '../store/rideStore';
import { computeProgress } from '../engines/progressEngine';
import { runLeaderboardEngine } from '../engines/leaderboardEngine';
import { haversine } from '../utils/geo';
import { enqueueBroadcast, buildStatePayload } from './broadcaster';
import {
  updateParticipantStatus,
  getParticipant,
} from '../db/participantRepo';
import { createRegroupEvent, resolveRegroupEvent } from '../db/regroupRepo';
import { createEmergencyEvent } from '../db/emergencyRepo';
import { RegroupType, ParticipantState } from '../types';

const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setupSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    const userName = socket.data.name as string;
    const userAvatar = socket.data.avatarUrl as string | null;

    // ride:join
    socket.on('ride:join', async ({ rideId }: { rideId: string }) => {
      // Validate DB participation
      const participant = await getParticipant(rideId, userId);
      if (!participant || participant.status === 'LEFT') {
        socket.emit('error', { error: 'NOT_A_PARTICIPANT' });
        return;
      }

      // Cancel pending disconnect timer if reconnecting
      const timerKey = `${rideId}:${userId}`;
      const timer = disconnectTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.delete(timerKey);
      }

      socket.join(`ride:${rideId}`);

      let state = rideStore.get(rideId);
      if (state) {
        // Active ride — restore or init participant in memory
        let pState = state.participants.get(userId);
        if (!pState) {
          pState = {
            userId,
            name: userName,
            avatarUrl: userAvatar,
            status: 'ACTIVE',
            lat: null,
            lng: null,
            speed: null,
            heading: null,
            progress: 0,
            offRoute: false,
            battery: null,
            signalStrength: null,
            updatedAt: null,
          };
          state.participants.set(userId, pState);
        } else {
          pState.status = 'ACTIVE';
        }

        // Send current state snapshot to this socket
        socket.emit('ride:state_update', buildStatePayload(state));

        // Broadcast join to room
        io.to(`ride:${rideId}`).emit('ride:participant_joined', {
          userId,
          name: userName,
          avatarUrl: userAvatar,
        });
      } else {
        // LOBBY or no in-memory state — just broadcast join
        io.to(`ride:${rideId}`).emit('ride:participant_joined', {
          userId,
          name: userName,
          avatarUrl: userAvatar,
        });
      }
    });

    // ride:leave
    socket.on('ride:leave', async ({ rideId }: { rideId: string }) => {
      socket.leave(`ride:${rideId}`);

      const state = rideStore.get(rideId);
      if (state) {
        const p = state.participants.get(userId);
        if (p) p.status = 'LEFT';
      }

      await updateParticipantStatus(rideId, userId, 'LEFT').catch(() => {});

      io.to(`ride:${rideId}`).emit('ride:participant_left', { userId });
    });

    // ride:ready (ack)
    socket.on(
      'ride:ready',
      async (
        { rideId }: { rideId: string },
        ack: (res: unknown) => void
      ) => {
        const state = rideStore.get(rideId);
        const participant = await getParticipant(rideId, userId);

        if (!participant || participant.status === 'LEFT') {
          if (typeof ack === 'function')
            ack({ ok: false, error: 'NOT_IN_RIDE' });
          return;
        }

        if (participant.status !== 'JOINED' && participant.status !== 'READY') {
          if (typeof ack === 'function')
            ack({ ok: false, error: 'UNAUTHORIZED' });
          return;
        }

        // Need to check ride status — get from DB or memory
        const inMemoryStatus = state?.status;
        if (inMemoryStatus && inMemoryStatus !== 'LOBBY') {
          if (typeof ack === 'function')
            ack({ ok: false, error: 'RIDE_NOT_LOBBY' });
          return;
        }

        await updateParticipantStatus(rideId, userId, 'READY');

        // Update memory if state exists
        if (state) {
          const p = state.participants.get(userId);
          if (p) p.status = 'READY';
        }

        // Check if all are ready
        const { rows } = await import('../db/pool').then(({ pool }) =>
          pool.query(
            `SELECT COUNT(*) FILTER (WHERE status = 'READY') as ready_count,
                    COUNT(*) as total
             FROM ride_participants WHERE ride_id = $1 AND status != 'LEFT'`,
            [rideId]
          )
        );
        const readyCount = parseInt(rows[0].ready_count, 10);
        const total = parseInt(rows[0].total, 10);
        const allReady = readyCount === total && total > 0;

        if (typeof ack === 'function') {
          ack({ ok: true, participantCount: total, allReady });
        }

        // Broadcast to room excluding sender
        socket.to(`ride:${rideId}`).emit('ride:participant_ready', {
          userId,
          participantCount: total,
          allReady,
        });
      }
    );

    // ride:location_update
    socket.on('ride:location_update', async (data: {
      rideId: string;
      lat: number;
      lng: number;
      speed: number;
      heading: number;
      timestamp: string;
      battery: number | null;
      signalStrength: 'STRONG' | 'MODERATE' | 'WEAK' | null;
    }) => {
      const state = rideStore.get(data.rideId);
      if (!state || state.status !== 'ACTIVE') return;

      const p = state.participants.get(userId);
      if (!p) return;

      // Update participant state
      p.lat = data.lat;
      p.lng = data.lng;
      p.speed = data.speed;
      p.heading = data.heading;
      p.battery = data.battery;
      p.signalStrength = data.signalStrength;
      p.updatedAt = data.timestamp;
      p.status = 'ACTIVE';

      // Progress engine
      if (state.routePoints.length >= 2) {
        const result = computeProgress(
          { lat: data.lat, lng: data.lng },
          state.routePoints,
          state.cumulativeDist
        );
        p.progress = result.progress;
        p.offRoute = result.offRoute;
      }

      // Leaderboard engine (includes compactness sampling + gap accumulation)
      const prevSplitActive = state.splitActive;
      runLeaderboardEngine(state);

      // Split detection events
      if (!prevSplitActive && state.splitActive && state.leaderboard.length >= 2) {
        const leader = state.leaderboard[0];
        const last = state.leaderboard[state.leaderboard.length - 1];
        io.to(`ride:${data.rideId}`).emit('ride:split_detected', {
          gapMeters: last.gapMeters,
          leaderId: leader.userId,
          lastRiderId: last.userId,
        });
      } else if (prevSplitActive && !state.splitActive && state.leaderboard.length >= 2) {
        const last = state.leaderboard[state.leaderboard.length - 1];
        io.to(`ride:${data.rideId}`).emit('ride:split_resolved', {
          gapMeters: last.gapMeters,
        });
      }

      // Regroup auto-resolution
      if (state.openRegroup && p.lat !== null && p.lng !== null) {
        const dist = haversine(
          { lat: p.lat, lng: p.lng },
          { lat: state.openRegroup.lat, lng: state.openRegroup.lng }
        );
        if (dist <= 100) {
          state.openRegroup.arrivedRiders.add(userId);
          const activeParticipants = Array.from(state.participants.values()).filter(
            (x) => x.status === 'ACTIVE'
          );
          const allArrived = activeParticipants.every((x) =>
            state.openRegroup!.arrivedRiders.has(x.userId)
          );
          if (allArrived) {
            const { regroupId } = state.openRegroup;
            state.openRegroup = null;
            await resolveRegroupEvent(regroupId).catch(() => {});
            io.to(`ride:${data.rideId}`).emit('ride:regroup_resolved', {
              regroupId,
              resolvedAt: new Date().toISOString(),
            });
          }
        }
      }

      // Throttled broadcast
      enqueueBroadcast(io, data.rideId, () => rideStore.get(data.rideId));
    });

    // ride:regroup (ack)
    socket.on(
      'ride:regroup',
      async (
        data: {
          rideId: string;
          type: RegroupType;
          lat: number;
          lng: number;
        },
        ack: (res: unknown) => void
      ) => {
        // EMERGENCY is rejected — use ride:emergency
        if ((data.type as string) === 'EMERGENCY') {
          if (typeof ack === 'function')
            ack({ ok: false, error: 'USE_EMERGENCY_EVENT' });
          return;
        }

        const state = rideStore.get(data.rideId);
        if (!state || state.status !== 'ACTIVE') {
          if (typeof ack === 'function') ack({ ok: false, error: 'RIDE_NOT_ACTIVE' });
          return;
        }

        // Only one open regroup at a time — resolve previous if exists
        if (state.openRegroup) {
          await resolveRegroupEvent(state.openRegroup.regroupId).catch(() => {});
          state.openRegroup = null;
        }

        const regroupId = await createRegroupEvent(
          data.rideId,
          userId,
          data.type,
          data.lat,
          data.lng
        );

        state.openRegroup = {
          regroupId,
          lat: data.lat,
          lng: data.lng,
          arrivedRiders: new Set(),
        };

        const createdAt = new Date().toISOString();

        if (typeof ack === 'function') ack({ ok: true, regroupId });

        io.to(`ride:${data.rideId}`).emit('ride:regroup_started', {
          regroupId,
          createdBy: userId,
          type: data.type,
          lat: data.lat,
          lng: data.lng,
          createdAt,
        });
      }
    );

    // ride:emergency (ack)
    socket.on(
      'ride:emergency',
      async (
        data: {
          rideId: string;
          lat: number;
          lng: number;
          message: string;
        },
        ack: (res: unknown) => void
      ) => {
        const state = rideStore.get(data.rideId);
        // Works during ACTIVE or PAUSED
        if (!state || (state.status !== 'ACTIVE' && state.status !== 'PAUSED')) {
          if (typeof ack === 'function') ack({ ok: false, error: 'RIDE_NOT_ACTIVE' });
          return;
        }

        const emergencyId = await createEmergencyEvent(
          data.rideId,
          userId,
          data.lat,
          data.lng,
          data.message
        );

        const createdAt = new Date().toISOString();

        if (typeof ack === 'function') ack({ ok: true, emergencyId });

        io.to(`ride:${data.rideId}`).emit('ride:emergency_started', {
          emergencyId,
          userId,
          lat: data.lat,
          lng: data.lng,
          message: data.message,
          createdAt,
          priority: 'CRITICAL',
        });
      }
    );

    // Disconnect handling
    socket.on('disconnect', () => {
      // Find all rooms this socket was in
      const rooms = Array.from(socket.rooms).filter((r) =>
        r.startsWith('ride:')
      );

      for (const room of rooms) {
        const rideId = room.slice(5);
        const state = rideStore.get(rideId);
        if (state) {
          const p = state.participants.get(userId);
          if (p) p.status = 'DISCONNECTED';
        }

        const timerKey = `${rideId}:${userId}`;
        const timer = setTimeout(async () => {
          disconnectTimers.delete(timerKey);
          await updateParticipantStatus(rideId, userId, 'DISCONNECTED').catch(
            () => {}
          );
        }, 30_000);

        disconnectTimers.set(timerKey, timer);
      }
    });
  });
}
