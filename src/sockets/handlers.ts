import { Server, Socket } from 'socket.io';
import { rideStore } from '../store/rideStore';
import { computeProgress } from '../engines/progressEngine';
import { runLeaderboardEngine } from '../engines/leaderboardEngine';
import { haversine } from '../utils/geo';
import { enqueueBroadcast, buildStatePayload } from './broadcaster';
import {
  updateParticipantStatus,
  getParticipant,
  getParticipantsWithUsers,
} from '../db/participantRepo';
import { getRideById, getRideWithPolyline } from '../db/rideRepo';
import { decodePolyline, computeCumulativeDist } from '../engines/polylineDecoder';
import { createRegroupEvent, resolveRegroupEvent } from '../db/regroupRepo';
import { createEmergencyEvent } from '../db/emergencyRepo';
import { RegroupType } from '../types';

const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setupSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    const userName = socket.data.name as string;
    const userAvatar = socket.data.avatarUrl as string | null;

    console.log(`[socket:connect] userId=${userId} name="${userName}" socketId=${socket.id}`);

    // ride:join
    socket.on('ride:join', async ({ rideId }: { rideId: string }) => {
      console.log(`[ride:join] userId=${userId} rideId=${rideId}`);
      // Validate DB participation
      const participant = await getParticipant(rideId, userId);
      if (!participant || participant.status === 'LEFT') {
        console.warn(`[ride:join] REJECTED — userId=${userId} not a participant of rideId=${rideId}`);
        socket.emit('error', { error: 'NOT_A_PARTICIPANT' });
        return;
      }
      console.log(`[ride:join] OK — userId=${userId} joined rideId=${rideId}`);

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

        // Broadcast join to room first, then push updated state to everyone
        // so navigation views on existing clients pick up the new participant immediately.
        io.to(`ride:${rideId}`).emit('ride:participant_joined', {
          userId,
          name: userName,
          avatarUrl: userAvatar,
        });
        io.to(`ride:${rideId}`).emit('ride:state_update', buildStatePayload(state));
      } else {
        // No in-memory state — fetch from DB to determine ride status
        const [ride, dbParticipants] = await Promise.all([
          getRideWithPolyline(rideId),
          getParticipantsWithUsers(rideId),
        ]);
        const leaderId = ride?.leader_id ?? '';

        if (ride && (ride.status === 'ACTIVE' || ride.status === 'PAUSED')) {
          // Server restarted while ride was running — rebuild in-memory state from DB
          const routePoints = decodePolyline(ride.route_polyline);
          const cumulativeDist = computeCumulativeDist(routePoints);

          const participantMap = new Map(
            dbParticipants
              .filter((p) => p.status !== 'LEFT')
              .map((p) => [
                p.user_id,
                {
                  userId: p.user_id,
                  name: p.name,
                  avatarUrl: p.avatar_url ?? null,
                  status: 'ACTIVE' as const,
                  lat: null,
                  lng: null,
                  speed: null,
                  heading: null,
                  progress: 0,
                  offRoute: false,
                  battery: null,
                  signalStrength: null,
                  updatedAt: null,
                },
              ])
          );

          const rebuiltState = {
            rideId,
            status: ride.status,
            leaderId,
            distanceMeters: ride.distance_meters,
            routePoints,
            cumulativeDist,
            participants: participantMap,
            leaderboard: [],
            splitActive: false,
            spreadSampleSum: 0,
            spreadSampleCount: 0,
            perRiderGapAccumulator: new Map(),
            openRegroup: null,
          };

          rideStore.set(rideId, rebuiltState);

          io.to(`ride:${rideId}`).emit('ride:participant_joined', {
            userId,
            name: userName,
            avatarUrl: userAvatar,
          });
          io.to(`ride:${rideId}`).emit('ride:state_update', buildStatePayload(rebuiltState));
        } else {
          // LOBBY — broadcast join and send full roster to joining client
          io.to(`ride:${rideId}`).emit('ride:participant_joined', {
            userId,
            name: userName,
            avatarUrl: userAvatar,
            status: 'JOINED',
            isLeader: userId === leaderId,
            joinedAt: new Date().toISOString(),
          });

          // Send full roster snapshot to the joining client only — ensures the
          // lobby roster is always populated even if the REST GET /rides/:id failed
          const active = dbParticipants.filter((p) => p.status !== 'LEFT');
          socket.emit('ride:lobby_roster', {
            leaderId,
            participants: active.map((p) => ({
              userId: p.user_id,
              name: p.name,
              avatarUrl: p.avatar_url ?? null,
              status: p.status,
              isLeader: p.user_id === leaderId,
              joinedAt: (p.joined_at as Date).toISOString(),
            })),
          });
        }
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
        console.log(`[ride:regroup] userId=${userId} rideId=${data.rideId} type=${data.type}`);

        // EMERGENCY is rejected — use ride:emergency
        if ((data.type as string) === 'EMERGENCY') {
          if (typeof ack === 'function')
            ack({ ok: false, error: 'USE_EMERGENCY_EVENT' });
          return;
        }

        const state = rideStore.get(data.rideId);
        if (!state || state.status !== 'ACTIVE') {
          console.warn(`[ride:regroup] BLOCKED — rideId=${data.rideId} state=${state?.status ?? 'NOT_IN_STORE'}`);
          if (typeof ack === 'function') ack({ ok: false, error: 'RIDE_NOT_ACTIVE' });
          return;
        }
        console.log(`[ride:regroup] proceeding to DB write — rideId=${data.rideId}`);

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

        const createdAt = new Date().toISOString();

        state.openRegroup = {
          regroupId,
          type: data.type,
          lat: data.lat,
          lng: data.lng,
          createdBy: userId,
          createdAt,
          arrivedRiders: new Set(),
        };

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

    // ride:regroup_arrived (ack) — manual "Mark as Arrived" from a rider
    socket.on(
      'ride:regroup_arrived',
      async (
        data: { rideId: string; regroupId: string },
        ack: (res: unknown) => void
      ) => {
        const state = rideStore.get(data.rideId);
        if (!state || state.status !== 'ACTIVE') {
          if (typeof ack === 'function') ack({ ok: false, error: 'RIDE_NOT_ACTIVE' });
          return;
        }
        if (!state.openRegroup || state.openRegroup.regroupId !== data.regroupId) {
          if (typeof ack === 'function') ack({ ok: false, error: 'REGROUP_NOT_FOUND' });
          return;
        }

        state.openRegroup.arrivedRiders.add(userId);

        const activeParticipants = Array.from(state.participants.values()).filter(
          (x) => x.status === 'ACTIVE'
        );
        const allArrived = activeParticipants.every((x) =>
          state.openRegroup!.arrivedRiders.has(x.userId)
        );

        if (typeof ack === 'function') ack({ ok: true });

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
        console.log(`[ride:emergency] userId=${userId} rideId=${data.rideId}`);

        const state = rideStore.get(data.rideId);
        // Works during ACTIVE or PAUSED
        if (!state || (state.status !== 'ACTIVE' && state.status !== 'PAUSED')) {
          console.warn(`[ride:emergency] BLOCKED — rideId=${data.rideId} state=${state?.status ?? 'NOT_IN_STORE'}`);
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

        // Notify all clients in the room so lobby presence dots update immediately
        io.to(room).emit('ride:participant_offline', { userId });

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
