import { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db/pool';
import {
  createRide,
  getRideById,
  getRideWithPolyline,
  getRideByInviteCode,
  getWaypoints,
  updateRide,
  updateRideStatus,
  WaypointInput,
} from '../db/rideRepo';
import { updateUserProfile } from '../db/userRepo';
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
import { generateRideSummary, generateFallbackSummary } from '../services/summaryService';
import { generateInviteCode } from '../utils/inviteCode';
import { decodePolyline, computeCumulativeDist } from '../engines/polylineDecoder';
import { rideStore } from '../store/rideStore';
import { getIO } from '../sockets/server';
import { buildStatePayload } from '../sockets/broadcaster';
import { ActiveRideState, WaypointType } from '../types';

const security = [{ bearerAuth: [] }];

const waypointSchema = {
  type: 'object',
  required: ['order', 'name', 'lat', 'lng', 'type'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    order: { type: 'integer' },
    name: { type: 'string' },
    lat: { type: 'number' },
    lng: { type: 'number' },
    type: { type: 'string', enum: ['START', 'WAYPOINT', 'DESTINATION'] },
  },
} as const;

const errorSchema = (description: string) => ({
  type: 'object',
  properties: { error: { type: 'string', description } },
});

export async function ridesRoutes(fastify: FastifyInstance): Promise<void> {
  // PATCH /users/me — sync display name + avatar from client
  fastify.patch('/users/me', {
    schema: {
      security,
      summary: 'Update current user profile (name + avatar)',
      tags: ['Users'],
      body: {
        type: 'object',
        properties: {
          name:      { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const body = request.body as { name?: string; avatarUrl?: string | null };
    if (body.name?.trim()) {
      await updateUserProfile(userId, body.name.trim(), body.avatarUrl ?? null);
    }
    return { ok: true };
  });

  // POST /rides
  fastify.post('/rides', {
    schema: {
      security,
      summary: 'Create a new ride',
      tags: ['Rides'],
      body: {
        type: 'object',
        required: ['title', 'destinationName', 'destinationLat', 'destinationLng',
                   'routePolyline', 'distanceMeters', 'estimatedDurationSeconds', 'waypoints'],
        properties: {
          title: { type: 'string' },
          destinationName: { type: 'string' },
          destinationLat: { type: 'number' },
          destinationLng: { type: 'number' },
          routePolyline: { type: 'string', description: 'Google encoded polyline' },
          distanceMeters: { type: 'number' },
          estimatedDurationSeconds: { type: 'number' },
          maxAllowedParticipants: { type: 'integer' },
          waypoints: { type: 'array', items: waypointSchema, minItems: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            rideId: { type: 'string', format: 'uuid' },
            inviteCode: { type: 'string' },
          },
        },
        400: errorSchema('MISSING_REQUIRED_FIELDS | INVALID_WAYPOINTS'),
        401: errorSchema('UNAUTHORIZED | INVALID_TOKEN'),
        403: errorSchema('QUOTA_EXCEEDED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
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

    // Validate required fields
    if (!body.title || !body.destinationName ||
        body.destinationLat == null || body.destinationLng == null ||
        !body.routePolyline || body.distanceMeters == null ||
        body.estimatedDurationSeconds == null) {
      return reply.code(400).send({ error: 'MISSING_REQUIRED_FIELDS' });
    }

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

    // Cap maxAllowedParticipants to plan limit; fall back to plan limit if not provided
    const requestedMax = Number(body.maxAllowedParticipants);
    const maxAllowed = Math.min(
      Number.isFinite(requestedMax) ? requestedMax : plan.max_riders_per_ride,
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

  // GET /rides/me — must be before /:rideId
  fastify.get('/rides/me', {
    schema: {
      security,
      summary: 'Get current user rides (all statuses)',
      tags: ['Rides'],
      response: {
        200: {
          type: 'object',
          properties: {
            rides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rideId:           { type: 'string' },
                  title:            { type: 'string' },
                  status:           { type: 'string' },
                  isLeader:         { type: 'boolean' },
                  inviteCode:       { type: 'string', nullable: true },
                  startedAt:        { type: 'string', nullable: true },
                  endedAt:          { type: 'string', nullable: true },
                  createdAt:        { type: 'string', nullable: true },
                  distanceMeters:   { type: 'number' },
                  durationSeconds:  { type: 'integer', nullable: true },
                  avgSpeedKmh:      { type: 'number', nullable: true },
                  compactnessScore: { type: 'number', nullable: true },
                },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rows } = await pool.query(
      `SELECT r.id, r.title, r.status, r.leader_id, r.invite_code,
              r.started_at, r.ended_at, r.created_at, r.distance_meters,
              rs.duration_seconds, rs.avg_speed_kmh, rs.compactness_score
       FROM ride_participants rp
       JOIN rides r ON r.id = rp.ride_id
       LEFT JOIN ride_summaries rs ON rs.ride_id = r.id
       WHERE rp.user_id = $1
         AND rp.status != 'LEFT'
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [userId]
    );

    return {
      rides: rows.map((r) => ({
        rideId:           r.id,
        title:            r.title,
        status:           r.status,
        isLeader:         r.leader_id === userId,
        inviteCode:       r.status !== 'COMPLETED' ? r.invite_code : null,
        startedAt:        r.started_at?.toISOString() ?? null,
        endedAt:          r.ended_at?.toISOString() ?? null,
        createdAt:        r.created_at?.toISOString() ?? null,
        distanceMeters:   r.distance_meters,
        durationSeconds:  r.duration_seconds ?? null,
        avgSpeedKmh:      r.avg_speed_kmh ?? null,
        compactnessScore: r.compactness_score != null
          ? Math.round(r.compactness_score * 100)
          : null,
      })),
    };
  });

  // GET /rides/join/:inviteCode — must be before /:rideId
  fastify.get('/rides/join/:inviteCode', {
    schema: {
      security,
      summary: 'Look up a ride by invite code',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { inviteCode: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            rideId: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            leaderName: { type: 'string' },
            participantCount: { type: 'integer' },
            maxParticipants: { type: 'integer' },
            status: { type: 'string' },
          },
        },
        404: errorSchema('INVITE_CODE_NOT_FOUND'),
        409: errorSchema('RIDE_ENDED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { inviteCode } = request.params as { inviteCode: string };
    const ride = await getRideByInviteCode(inviteCode);

    if (!ride) {
      return reply.code(404).send({ error: 'INVITE_CODE_NOT_FOUND' });
    }

    if (ride.status === 'COMPLETED') {
      return reply.code(409).send({ error: 'RIDE_ENDED', status: ride.status });
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
  fastify.get('/rides/:rideId', {
    schema: {
      security,
      summary: 'Get ride details',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['LOBBY', 'ACTIVE', 'PAUSED', 'COMPLETED'] },
            leaderId: { type: 'string' },
            inviteCode: { type: 'string' },
            destinationName: { type: 'string' },
            destinationLat: { type: 'number' },
            destinationLng: { type: 'number' },
            distanceMeters: { type: 'number' },
            estimatedDurationSeconds: { type: 'number' },
            maxAllowedParticipants: { type: 'integer' },
            startedAt: { type: 'string', format: 'date-time', nullable: true },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            waypoints: { type: 'array', items: waypointSchema },
            participants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  name: { type: 'string' },
                  avatarUrl: { type: 'string', nullable: true },
                  status: { type: 'string' },
                  isLeader: { type: 'boolean' },
                  joinedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        404: errorSchema('RIDE_NOT_FOUND'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
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

  // PATCH /rides/:rideId — update ride details (leader only, LOBBY only)
  fastify.patch('/rides/:rideId', {
    schema: {
      security,
      summary: 'Update ride details (leader, LOBBY only)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['title', 'destinationName', 'destinationLat', 'destinationLng',
                   'routePolyline', 'distanceMeters', 'estimatedDurationSeconds', 'waypoints'],
        properties: {
          title:                    { type: 'string' },
          destinationName:          { type: 'string' },
          destinationLat:           { type: 'number' },
          destinationLng:           { type: 'number' },
          routePolyline:            { type: 'string' },
          distanceMeters:           { type: 'number' },
          estimatedDurationSeconds: { type: 'number' },
          maxAllowedParticipants:   { type: 'integer' },
          waypoints: { type: 'array', items: waypointSchema, minItems: 1 },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: errorSchema('INVALID_WAYPOINTS'),
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_IN_LOBBY'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };
    const body = request.body as {
      title: string;
      destinationName: string;
      destinationLat: number;
      destinationLng: number;
      routePolyline: string;
      distanceMeters: number;
      estimatedDurationSeconds: number;
      maxAllowedParticipants?: number;
      waypoints: { order: number; name: string; lat: number; lng: number; type: string }[];
    };

    const hasDestination = body.waypoints?.some((w) => w.type === 'DESTINATION');
    if (!hasDestination) return reply.code(400).send({ error: 'INVALID_WAYPOINTS' });

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    if (ride.status !== 'LOBBY') return reply.code(409).send({ error: 'RIDE_NOT_IN_LOBBY' });

    // Cap maxAllowedParticipants to the plan limit recorded at ride creation time
    const planMax = (ride.membership_snapshot as { maxRidersPerRide: number }).maxRidersPerRide;
    const requestedMax = body.maxAllowedParticipants ?? ride.max_allowed_participants;
    const maxAllowed = Math.min(requestedMax, planMax);

    await updateRide(rideId, {
      title:                    body.title,
      destinationName:          body.destinationName,
      destinationLat:           body.destinationLat,
      destinationLng:           body.destinationLng,
      routePolyline:            body.routePolyline,
      distanceMeters:           body.distanceMeters,
      estimatedDurationSeconds: body.estimatedDurationSeconds,
      maxAllowedParticipants:   maxAllowed,
      waypoints: body.waypoints as WaypointInput[],
    });

    getIO().to(`ride:${rideId}`).emit('ride:updated', {
      rideId,
      title:                    body.title,
      destinationName:          body.destinationName,
      destinationLat:           body.destinationLat,
      destinationLng:           body.destinationLng,
      distanceMeters:           body.distanceMeters,
      estimatedDurationSeconds: body.estimatedDurationSeconds,
      maxAllowedParticipants:   maxAllowed,
      waypoints: body.waypoints.map((w) => ({
        order: w.order,
        name:  w.name,
        lat:   w.lat,
        lng:   w.lng,
        type:  w.type,
      })),
    });

    return { ok: true };
  });

  // POST /rides/:rideId/join
  fastify.post('/rides/:rideId/join', {
    schema: {
      security,
      summary: 'Join a ride',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: errorSchema('QUOTA_EXCEEDED'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_ENDED | ALREADY_JOINED | RIDE_FULL'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.status === 'COMPLETED') return reply.code(409).send({ error: 'RIDE_ENDED' });

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
  fastify.post('/rides/:rideId/start', {
    schema: {
      security,
      summary: 'Start a ride (leader only)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_IN_LOBBY'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
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
  fastify.post('/rides/:rideId/pause', {
    schema: {
      security,
      summary: 'Pause an active ride (leader only)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_ACTIVE'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
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
  fastify.post('/rides/:rideId/resume', {
    schema: {
      security,
      summary: 'Resume a paused ride (leader only)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_PAUSED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
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
  fastify.post('/rides/:rideId/end', {
    schema: {
      security,
      summary: 'End a ride (leader only)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, rideId: { type: 'string', format: 'uuid' } },
        },
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_ACTIVE_OR_PAUSED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
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

    const estDuration = ride.estimated_duration_seconds ?? undefined;
    if (state && ride.started_at) {
      await generateRideSummary(rideId, ride.started_at, endedAt, state, estDuration);
    } else if (ride.started_at) {
      // In-memory state lost (server restart). Create a fallback summary from DB data.
      await generateFallbackSummary(
        rideId, ride.leader_id, ride.started_at, endedAt, ride.distance_meters, estDuration
      );
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
  fastify.get('/rides/:rideId/summary', {
    schema: {
      security,
      summary: 'Get post-ride summary',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            rideId: { type: 'string', format: 'uuid' },
            durationSeconds: { type: 'number' },
            distanceMeters: { type: 'number' },
            avgSpeedKmh: { type: 'number' },
            maxGroupSplitMeters: { type: 'number' },
            compactnessScore: { type: 'integer', description: '0-100' },
            totalRegroups: { type: 'integer' },
            totalEmergencies: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            participants: { type: 'array', items: { type: 'object' } },
          },
        },
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_COMPLETED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.status !== 'COMPLETED') {
      return reply.code(409).send({ error: 'RIDE_NOT_COMPLETED' });
    }

    let result = await getSummaryWithParticipants(rideId);
    if (!result) {
      // No summary record — generate a fallback now so it exists for future calls too
      const endedAt = ride.ended_at ?? new Date();
      if (ride.started_at) {
        await generateFallbackSummary(
          rideId, ride.leader_id, ride.started_at, endedAt, ride.distance_meters
        );
        result = await getSummaryWithParticipants(rideId);
      }
      if (!result) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    }

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
