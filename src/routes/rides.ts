import { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db/pool';
import {
  createRide,
  getRideById,
  getRideWithPolyline,
  getRideByInviteCode,
  getWaypoints,
  updateRideStatus,
} from '../db/rideRepo';
import {
  addParticipant,
  getParticipant,
  countActiveParticipants,
  getParticipantsWithUsers,
  markQuotaConsumed,
  updateParticipantStatus,
} from '../db/participantRepo';
import { getSummaryWithParticipants } from '../db/summaryRepo';
import { canUserParticipate, getUserPlanOrFree } from '../services/quotaService';
import { generateRideSummary } from '../services/summaryService';
import { generateInviteCode } from '../utils/inviteCode';
import { decodePolyline, computeCumulativeDist } from '../engines/polylineDecoder';
import { rideStore } from '../store/rideStore';
import { getIO } from '../sockets/server';
import { buildStatePayload } from '../sockets/broadcaster';
import { ActiveRideState, WaypointType } from '../types';

export async function ridesRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /rides
  fastify.post('/rides', async (request: FastifyRequest, reply) => {
    const { userId, name, avatarUrl } = request.user;

    const body = request.body as {
      title: string;
      destinationName: string;
      destinationLat: number;
      destinationLng: number;
      routePolyline: string;
      distanceMeters: number;
      estimatedDurationSeconds: number;
      maxAllowedParticipants: number;
      waypoints: {
        order: number;
        name: string;
        lat: number;
        lng: number;
        type: string;
      }[];
    };

    // Validate DESTINATION waypoint exists
    const hasDestination = body.waypoints?.some((w) => w.type === 'DESTINATION');
    if (!hasDestination) {
      return reply.code(400).send({ error: 'INVALID_WAYPOINTS' });
    }

    // Check monthly quota
    const quota = await canUserParticipate(userId);
    if (!quota.allowed) {
      return reply.code(403).send({
        error: 'QUOTA_EXCEEDED',
        used: quota.used,
        limit: quota.limit,
      });
    }

    const plan = quota.plan;

    // Cap maxAllowedParticipants to plan limit
    const maxAllowed = Math.min(
      body.maxAllowedParticipants,
      plan.max_riders_per_ride
    );

    // Generate invite code with one retry on collision
    let inviteCode = generateInviteCode();
    let rideId: string;
    try {
      rideId = await createRide(userId, {
        title: body.title,
        destinationName: body.destinationName,
        destinationLat: body.destinationLat,
        destinationLng: body.destinationLng,
        routePolyline: body.routePolyline,
        distanceMeters: body.distanceMeters,
        estimatedDurationSeconds: body.estimatedDurationSeconds,
        maxAllowedParticipants: maxAllowed,
        membershipSnapshot: {
          monthlyLimit: plan.monthly_ride_participation_limit,
          maxRidersPerRide: plan.max_riders_per_ride,
        },
        waypoints: body.waypoints as {
          order: number;
          name: string;
          lat: number;
          lng: number;
          type: WaypointType;
        }[],
      }, inviteCode);
    } catch (err: unknown) {
      // Retry once on invite code collision
      if (
        err instanceof Error &&
        err.message.includes('rides_invite_code_idx')
      ) {
        inviteCode = generateInviteCode();
        rideId = await createRide(userId, {
          title: body.title,
          destinationName: body.destinationName,
          destinationLat: body.destinationLat,
          destinationLng: body.destinationLng,
          routePolyline: body.routePolyline,
          distanceMeters: body.distanceMeters,
          estimatedDurationSeconds: body.estimatedDurationSeconds,
          maxAllowedParticipants: maxAllowed,
          membershipSnapshot: {
            monthlyLimit: plan.monthly_ride_participation_limit,
            maxRidersPerRide: plan.max_riders_per_ride,
          },
          waypoints: body.waypoints as {
            order: number;
            name: string;
            lat: number;
            lng: number;
            type: WaypointType;
          }[],
        }, inviteCode);
      } else {
        throw err;
      }
    }

    // Auto-join leader as participant
    await addParticipant(rideId, userId);

    return { rideId, inviteCode };
  });

  // GET /rides/join/:inviteCode — must be before /:rideId
  fastify.get('/rides/join/:inviteCode', async (request: FastifyRequest, reply) => {
    const { inviteCode } = request.params as { inviteCode: string };
    const ride = await getRideByInviteCode(inviteCode);

    if (!ride) {
      return reply.code(404).send({ error: 'INVITE_CODE_NOT_FOUND' });
    }

    if (ride.status !== 'LOBBY') {
      return reply.code(409).send({ error: 'RIDE_NOT_IN_LOBBY', status: ride.status });
    }

    return {
      rideId: ride.id,
      title: ride.title,
      leaderName: ride.leaderName,
      participantCount: ride.participantCount,
      maxParticipants: ride.maxParticipants,
      status: ride.status,
    };
  });

  // GET /rides/:rideId
  fastify.get('/rides/:rideId', async (request: FastifyRequest, reply) => {
    const { rideId } = request.params as { rideId: string };
    const ride = await getRideById(rideId);

    if (!ride) {
      return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    }

    const [waypoints, participants] = await Promise.all([
      getWaypoints(rideId),
      getParticipantsWithUsers(rideId),
    ]);

    return {
      id: ride.id,
      title: ride.title,
      status: ride.status,
      leaderId: ride.leader_id,
      inviteCode: ride.invite_code,
      destinationName: ride.destination_name,
      destinationLat: ride.destination_lat,
      destinationLng: ride.destination_lng,
      distanceMeters: ride.distance_meters,
      estimatedDurationSeconds: ride.estimated_duration_seconds,
      maxAllowedParticipants: ride.max_allowed_participants,
      startedAt: ride.started_at,
      endedAt: ride.ended_at,
      createdAt: ride.created_at,
      waypoints: waypoints.map((w) => ({
        id: w.id,
        order: w.order,
        name: w.name,
        lat: w.lat,
        lng: w.lng,
        type: w.type,
      })),
      participants: participants
        .filter((p) => p.status !== 'LEFT')
        .map((p) => ({
          userId: p.user_id,
          name: p.name,
          avatarUrl: p.avatar_url,
          status: p.status,
          isLeader: p.user_id === ride.leader_id,
          joinedAt: p.joined_at,
        })),
    };
  });

  // POST /rides/:rideId/join
  fastify.post('/rides/:rideId/join', async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.status !== 'LOBBY') return reply.code(409).send({ error: 'RIDE_NOT_IN_LOBBY' });

    const existing = await getParticipant(rideId, userId);
    if (existing && existing.status !== 'LEFT') {
      return reply.code(409).send({ error: 'ALREADY_JOINED' });
    }

    const current = await countActiveParticipants(rideId);
    if (current >= ride.max_allowed_participants) {
      return reply.code(409).send({
        error: 'RIDE_FULL',
        maxAllowed: ride.max_allowed_participants,
        current,
      });
    }

    const quota = await canUserParticipate(userId);
    if (!quota.allowed) {
      return reply.code(403).send({
        error: 'QUOTA_EXCEEDED',
        used: quota.used,
        limit: quota.limit,
      });
    }

    if (existing) {
      // Re-joining after LEFT
      await updateParticipantStatus(rideId, userId, 'JOINED');
    } else {
      await addParticipant(rideId, userId);
    }

    return { ok: true };
  });

  // POST /rides/:rideId/start
  fastify.post('/rides/:rideId/start', async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideWithPolyline(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    if (ride.status !== 'LOBBY') return reply.code(409).send({ error: 'RIDE_NOT_IN_LOBBY' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await updateRideStatus(rideId, 'ACTIVE', { started_at: new Date() }, client);
      await markQuotaConsumed(rideId, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Build in-memory state
    const routePoints = decodePolyline(ride.route_polyline);
    const cumulativeDist = computeCumulativeDist(routePoints);

    const participants = await getParticipantsWithUsers(rideId);
    const participantMap = new Map(
      participants
        .filter((p) => p.status !== 'LEFT')
        .map((p) => [
          p.user_id,
          {
            userId: p.user_id,
            name: p.name,
            avatarUrl: p.avatar_url,
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

    const state: ActiveRideState = {
      rideId,
      status: 'ACTIVE',
      leaderId: userId,
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

    rideStore.set(rideId, state);

    try {
      getIO().to(`ride:${rideId}`).emit('ride:state_update', buildStatePayload(state));
    } catch {
      // Socket.IO not yet initialized (e.g. in tests)
    }

    return { ok: true };
  });

  // POST /rides/:rideId/pause
  fastify.post('/rides/:rideId/pause', async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    if (ride.status !== 'ACTIVE') return reply.code(409).send({ error: 'RIDE_NOT_ACTIVE' });

    await updateRideStatus(rideId, 'PAUSED');

    const state = rideStore.get(rideId);
    if (state) state.status = 'PAUSED';

    try {
      getIO()
        .to(`ride:${rideId}`)
        .emit('ride:paused', { rideId, pausedAt: new Date().toISOString() });
    } catch { /* no-op */ }

    return { ok: true };
  });

  // POST /rides/:rideId/resume
  fastify.post('/rides/:rideId/resume', async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    if (ride.status !== 'PAUSED') return reply.code(409).send({ error: 'RIDE_NOT_PAUSED' });

    await updateRideStatus(rideId, 'ACTIVE');

    const state = rideStore.get(rideId);
    if (state) state.status = 'ACTIVE';

    try {
      getIO()
        .to(`ride:${rideId}`)
        .emit('ride:resumed', { rideId, resumedAt: new Date().toISOString() });
    } catch { /* no-op */ }

    return { ok: true };
  });

  // POST /rides/:rideId/end
  fastify.post('/rides/:rideId/end', async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    if (ride.status !== 'ACTIVE' && ride.status !== 'PAUSED') {
      return reply.code(409).send({ error: 'RIDE_NOT_ACTIVE_OR_PAUSED' });
    }

    const endedAt = new Date();
    await updateRideStatus(rideId, 'COMPLETED', { ended_at: endedAt });

    const state = rideStore.get(rideId);

    if (state && ride.started_at) {
      await generateRideSummary(rideId, ride.started_at, endedAt, state);
    }

    rideStore.delete(rideId);

    try {
      getIO()
        .to(`ride:${rideId}`)
        .emit('ride:ride_ended', { rideId, summaryAvailable: true });
    } catch { /* no-op */ }

    return { ok: true, rideId };
  });

  // GET /rides/:rideId/summary
  fastify.get('/rides/:rideId/summary', async (request: FastifyRequest, reply) => {
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.status !== 'COMPLETED') {
      return reply.code(409).send({ error: 'RIDE_NOT_COMPLETED' });
    }

    const result = await getSummaryWithParticipants(rideId);
    if (!result) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });

    const { summary, participants } = result;

    return {
      rideId: summary.rideId,
      durationSeconds: summary.durationSeconds,
      distanceMeters: summary.distanceMeters,
      avgSpeedKmh: summary.avgSpeedKmh,
      maxGroupSplitMeters: summary.maxGroupSplitMeters,
      compactnessScore: Math.round(summary.compactnessScore * 100),
      totalRegroups: summary.totalRegroups,
      totalEmergencies: summary.totalEmergencies,
      createdAt: summary.createdAt,
      participants,
    };
  });
}
