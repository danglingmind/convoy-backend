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
  deleteRide,
  WaypointInput,
} from '../db/rideRepo';
import {
  updateUserProfile,
  updateExtendedProfile,
  getAccountRideIds,
  deleteUserAccount,
} from '../db/userRepo';
import { getNearbyRides } from '../db/discoveryRepo';
import {
  addParticipant,
  getParticipant,
  countActiveParticipants,
  getParticipantsWithUsers,
  markQuotaConsumed,
  updateParticipantStatus,
} from '../db/participantRepo';
import { getSummaryWithParticipants } from '../db/summaryRepo';
import { canUserParticipate, getUserPlanOrFree, QuotaResult, readDeviceId, deviceIdHeaderSchema } from '../services/quotaService';
import { capture, captureReq, km } from '../services/analytics';
import { generateRideSummary, generateFallbackSummary } from '../services/summaryService';
import { deleteClerkUser } from '../services/clerkAdmin';
import { generateInviteCode } from '../utils/inviteCode';
import { decodePolyline, computeCumulativeDist } from '../engines/polylineDecoder';
import { runLeaderboardEngine } from '../engines/leaderboardEngine';
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

// Declares the extra fields so Fastify's response serializer doesn't strip them.
const participationDeniedSchema = {
  type: 'object',
  properties: {
    error:       { type: 'string', description: 'TRIAL_EXPIRED | QUOTA_EXCEEDED' },
    used:        { type: 'integer', description: 'Rides counted this month' },
    limit:       { type: 'integer', nullable: true, description: 'Monthly ride limit; null = unlimited' },
    trialEndsAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

/** 403 body for a create/join the rider's plan doesn't allow. */
function participationDenied(quota: QuotaResult) {
  return {
    error: quota.reason,
    used: quota.used,
    limit: quota.limit,
    trialEndsAt: quota.trial.endsAt?.toISOString() ?? null,
  };
}

/**
 * Tell everyone in a deleted account's rides that those rides are gone, and drop the live state —
 * the same teardown `DELETE /rides/:rideId` performs, applied to each ride the account led.
 */
async function announceRidesDeleted(rideIds: string[], deletedBy: string): Promise<void> {
  for (const rideId of rideIds) {
    rideStore.delete(rideId);
    try {
      getIO().to(`ride:${rideId}`).emit('ride:deleted', { rideId, deletedBy });
      const sockets = await getIO().in(`ride:${rideId}`).fetchSockets();
      for (const s of sockets) s.leave(`ride:${rideId}`);
    } catch {
      // Socket.IO not initialized (e.g. tests) — the DB delete still stands.
    }
  }
}

/**
 * Remove a departed rider from the rides that outlive them, exactly as `POST /rides/:id/leave`
 * does — including DELETING them from the live state rather than flagging them. `buildStatePayload`
 * maps every entry in `state.participants` with no status filter, so an entry left behind keeps
 * broadcasting a dead account's last position as a map pin and a leaderboard row.
 */
async function announceParticipantLeft(rideIds: string[], userId: string): Promise<void> {
  for (const rideId of rideIds) {
    const state = rideStore.get(rideId);
    if (state) {
      state.participants.delete(userId);
      // Recompute now, so the snapshot below carries a leaderboard without them instead of a
      // stale one that the next location tick happens to correct.
      runLeaderboardEngine(state);
    }
    try {
      getIO().to(`ride:${rideId}`).emit('ride:participant_left', { userId });
      if (state) {
        getIO().to(`ride:${rideId}`).emit('ride:state_update', buildStatePayload(state));
      }
      const sockets = await getIO().in(`ride:${rideId}`).fetchSockets();
      for (const s of sockets) {
        if (s.data.userId === userId) s.leave(`ride:${rideId}`);
      }
    } catch {
      // Socket.IO not initialized (e.g. tests).
    }
  }
}

export async function ridesRoutes(fastify: FastifyInstance): Promise<void> {
  // PATCH /users/me — sync display name + avatar + extended profile fields
  fastify.patch('/users/me', {
    schema: {
      security,
      summary: 'Update current user profile',
      tags: ['Users'],
      body: {
        type: 'object',
        properties: {
          name:                 { type: 'string' },
          avatarUrl:            { type: 'string', nullable: true },
          username:             { type: 'string', nullable: true },
          phone:                { type: 'string', nullable: true },
          phoneVisible:         { type: 'boolean' },
          emailContact:         { type: 'string', nullable: true },
          emailContactVisible:  { type: 'boolean' },
          notifyNearbyRides:    { type: 'boolean' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        409: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const body = request.body as {
      name?: string;
      avatarUrl?: string | null;
      username?: string | null;
      phone?: string | null;
      phoneVisible?: boolean;
      emailContact?: string | null;
      emailContactVisible?: boolean;
      notifyNearbyRides?: boolean;
    };

    if (body.name?.trim()) {
      await updateUserProfile(userId, body.name.trim(), body.avatarUrl ?? null);
    }

    const { usernameConflict } = await updateExtendedProfile(userId, {
      username:            body.username,
      phone:               body.phone,
      phoneVisible:        body.phoneVisible,
      emailContact:        body.emailContact,
      emailContactVisible: body.emailContactVisible,
      notifyNearbyRides:   body.notifyNearbyRides,
    });

    if (usernameConflict) {
      return reply.code(409).send({ error: 'USERNAME_TAKEN' });
    }

    return { ok: true };
  });

  // DELETE /users/me — erase the account and everything belonging to it
  //
  // Required by Google Play of any app that lets people create an account, and what it requires is
  // deletion, not deactivation: nothing here freezes, anonymises or flags. This is consequently
  // the one endpoint that will delete a COMPLETED ride, which `DELETE /rides/:rideId` refuses —
  // keeping a historical record cannot outrank the right to erasure.
  fastify.delete('/users/me', {
    schema: {
      security,
      summary: 'Delete the current account and all of its data',
      tags: ['Users'],
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        500: errorSchema('ACCOUNT_DELETE_FAILED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;

    // Read the ride ids while there is still something to read them from.
    const { led, joined } = await getAccountRideIds(userId);

    let counts;
    try {
      counts = await deleteUserAccount(userId);
    } catch (err) {
      // The whole thing is one transaction, so this leaves the account exactly as it was.
      request.log.error({ err, userId }, 'account deletion rolled back; nothing was deleted');
      return reply.code(500).send({ error: 'ACCOUNT_DELETE_FAILED' });
    }

    // Broadcast AFTER the rows are gone, which is the opposite of `DELETE /rides/:rideId`.
    //
    // That route announces first so the room empties while the ride still exists, and for a single
    // ride deleted by a single statement that is right. This tears down an account across seven
    // tables in one transaction: announcing first would mean a rollback leaves every rider in
    // every one of those rides told that rides which still exist have vanished. Announcing after
    // can at worst race a client into a 404 on a ride that genuinely is gone — and the clients
    // already read RIDE_NOT_FOUND as "leave this ride".
    await announceRidesDeleted(led, userId);
    await announceParticipantLeft(joined, userId);

    // Last, and only once the data is actually gone. See `deleteClerkUser` for why this cannot go
    // first. A failure is reported rather than swallowed: the rider retries, `clerkAuth` recreates
    // an empty row, and the second pass finishes the job — whereas reporting success would leave a
    // working sign-in attached to nothing.
    try {
      await deleteClerkUser(userId);
    } catch (err) {
      request.log.error(
        { err, userId },
        'data deleted but Clerk identity remains; a retry will finish it'
      );
      return reply.code(500).send({ error: 'ACCOUNT_DELETE_FAILED' });
    }

    request.log.info({ userId, ...counts }, 'account deleted');
    captureReq(request, userId, 'account_deleted');
    return { ok: true };
  });

  // GET /rides/nearby — discover rides starting within radiusKm of caller's location
  fastify.get('/rides/nearby', {
    schema: {
      security,
      summary: 'Get rides starting near a given location',
      tags: ['Rides'],
      querystring: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat:      { type: 'number' },
          lng:      { type: 'number' },
          radiusKm: { type: 'number', default: 20 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            rides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:                 { type: 'string' },
                  title:              { type: 'string' },
                  status:             { type: 'string' },
                  destinationName:    { type: 'string' },
                  distanceMeters:     { type: 'number' },
                  startLat:           { type: 'number' },
                  startLng:           { type: 'number' },
                  distanceFromUserKm: { type: 'number' },
                  riderCount:         { type: 'integer' },
                  maxParticipants:    { type: 'integer' },
                  leaderName:         { type: 'string' },
                  leaderId:           { type: 'string' },
                  inviteCode:         { type: 'string' },
                  viewerRole:         { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const q = request.query as { lat?: number; lng?: number; radiusKm?: number };
    if (q.lat == null || q.lng == null) {
      return reply.code(400).send({ error: 'lat and lng are required' });
    }
    const radiusKm = Math.min(q.radiusKm ?? 20, 50);
    const rows = await getNearbyRides(userId, q.lat, q.lng, radiusKm);
    return {
      rides: rows.map(r => ({
        id:                 r.id,
        title:              r.title,
        status:             r.status,
        destinationName:    r.destination_name,
        distanceMeters:     r.distance_meters,
        startLat:           r.start_lat,
        startLng:           r.start_lng,
        distanceFromUserKm: Math.round(r.distance_from_user_km * 10) / 10,
        riderCount:         Number(r.rider_count),
        maxParticipants:    r.max_participants,
        leaderName:         r.leader_name,
        leaderId:           r.leader_id,
        inviteCode:         r.invite_code,
        viewerRole:         r.viewer_is_leader ? 'LEADER'
                          : r.viewer_is_participant ? 'MEMBER'
                          : null,
      })),
    };
  });

  // POST /rides
  fastify.post('/rides', {
    schema: {
      security,
      summary: 'Create a new ride',
      headers: deviceIdHeaderSchema,
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
        403: participationDeniedSchema,
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

    // Free trial, then monthly quota
    const quota = await canUserParticipate(userId, readDeviceId(request.headers));
    if (!quota.allowed) {
      return reply.code(403).send(participationDenied(quota));
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

    captureReq(request, userId, 'ride_created', {
      distance_km: km(Number(body.distanceMeters)),
      est_duration_min: Math.round(Number(body.estimatedDurationSeconds) / 60) || undefined,
      waypoint_count: Array.isArray(body.waypoints) ? body.waypoints.length : 0,
      max_riders: maxAllowed,
      plan: plan.code,
    });

    return { rideId, inviteCode };
  });

  // GET /rides/me — must be before /:rideId
  fastify.get('/rides/me', {
    schema: {
      security,
      summary: 'Get current user rides, optionally filtered by status',
      tags: ['Rides'],
      querystring: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description:
              "Comma-separated ride statuses to include, e.g. 'COMPLETED' for a history list " +
              "or 'LOBBY,ACTIVE,PAUSED' for rides still in progress. Omit for every status. " +
              'Filtering here rather than on the client means the 50-row limit is spent on rows ' +
              'the caller will actually show.',
          },
        },
      },
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
    const statusParam = (request.query as { status?: string }).status;
    const statuses = statusParam
      ? statusParam.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean)
      : [];
    // Passing null for the array leaves the filter inert, so an omitted `status` keeps the
    // previous behaviour of returning every status.
    const { rows } = await pool.query(
      `SELECT r.id, r.title, r.status, r.leader_id, r.invite_code,
              r.started_at, r.ended_at, r.created_at, r.distance_meters,
              rs.duration_seconds, rs.avg_speed_kmh, rs.compactness_score
       FROM ride_participants rp
       JOIN rides r ON r.id = rp.ride_id
       LEFT JOIN ride_summaries rs ON rs.ride_id = r.id
       WHERE rp.user_id = $1
         AND rp.status != 'LEFT'
         AND ($2::text[] IS NULL OR r.status = ANY($2::text[]))
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [userId, statuses.length > 0 ? statuses : null]
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
            routePolyline: { type: 'string', nullable: true, description: 'Google encoded polyline of the leader-selected route' },
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
    const ride = await getRideWithPolyline(rideId);

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
      routePolyline: ride.route_polyline,
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

  // PATCH /rides/:rideId — update ride details (leader only; any state except COMPLETED)
  fastify.patch('/rides/:rideId', {
    schema: {
      security,
      summary: 'Update ride details (leader only; any state except COMPLETED)',
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
        409: errorSchema('RIDE_ENDED'),
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
    // The leader may edit in any state except COMPLETED (LOBBY, ACTIVE and PAUSED are all editable).
    if (ride.status === 'COMPLETED') return reply.code(409).send({ error: 'RIDE_ENDED' });

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

    // If the ride is live (ACTIVE/PAUSED), swap the in-memory route geometry so progress,
    // off-route and the leaderboard follow the NEW route. computeProgress re-projects each
    // rider's GPS onto routePoints every tick, so this re-syncs on the next location update
    // — no need to migrate existing progress values. LOBBY rides have no live state yet.
    const liveState = rideStore.get(rideId);
    if (liveState) {
      liveState.distanceMeters = body.distanceMeters;
      liveState.routePoints    = decodePolyline(body.routePolyline);
      liveState.cumulativeDist = computeCumulativeDist(liveState.routePoints);
    }

    getIO().to(`ride:${rideId}`).emit('ride:updated', {
      rideId,
      title:                    body.title,
      destinationName:          body.destinationName,
      destinationLat:           body.destinationLat,
      destinationLng:           body.destinationLng,
      distanceMeters:           body.distanceMeters,
      estimatedDurationSeconds: body.estimatedDurationSeconds,
      maxAllowedParticipants:   maxAllowed,
      routePolyline:            body.routePolyline,
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

  // DELETE /rides/:rideId — leader deletes the ride entirely (any state except COMPLETED)
  fastify.delete('/rides/:rideId', {
    schema: {
      security,
      summary: 'Delete a ride (leader only; any state except COMPLETED)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_ENDED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    // COMPLETED rides own a ride_summaries row (no ON DELETE CASCADE) and are historical
    // records — they can never be deleted.
    if (ride.status === 'COMPLETED') return reply.code(409).send({ error: 'RIDE_ENDED' });

    // Notify everyone in the room BEFORE the row disappears so their apps can exit the ride,
    // then drop any live in-memory state and hard-delete (cascades to children).
    getIO().to(`ride:${rideId}`).emit('ride:deleted', { rideId, deletedBy: userId });

    rideStore.delete(rideId);

    try {
      const sockets = await getIO().in(`ride:${rideId}`).fetchSockets();
      for (const s of sockets) s.leave(`ride:${rideId}`);
    } catch {
      // Socket.IO not initialized (e.g. tests) — DB delete + broadcast still applied.
    }

    await deleteRide(rideId);
    captureReq(request, userId, 'ride_deleted', { ride_status: ride.status });

    return { ok: true };
  });

  // DELETE /rides/:rideId/participants/:targetUserId — leader removes a participant
  fastify.delete('/rides/:rideId/participants/:targetUserId', {
    schema: {
      security,
      summary: 'Remove a participant from a ride (leader only)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: {
          rideId:       { type: 'string', format: 'uuid' },
          targetUserId: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: errorSchema('CANNOT_REMOVE_LEADER'),
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND | PARTICIPANT_NOT_FOUND'),
        409: errorSchema('RIDE_ENDED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId, targetUserId } = request.params as {
      rideId: string;
      targetUserId: string;
    };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    if (ride.status === 'COMPLETED') return reply.code(409).send({ error: 'RIDE_ENDED' });
    if (targetUserId === ride.leader_id) {
      return reply.code(400).send({ error: 'CANNOT_REMOVE_LEADER' });
    }

    const target = await getParticipant(rideId, targetUserId);
    if (!target || target.status === 'LEFT') {
      return reply.code(404).send({ error: 'PARTICIPANT_NOT_FOUND' });
    }

    await updateParticipantStatus(rideId, targetUserId, 'LEFT');
    captureReq(request, userId, 'rider_removed', { ride_status: ride.status });

    // Drop from in-memory state if the ride is already live
    const state = rideStore.get(rideId);
    if (state) state.participants.delete(targetUserId);

    // Notify everyone still in the room (including the removed rider) so rosters
    // update live and the removed rider's app can exit the ride.
    getIO().to(`ride:${rideId}`).emit('ride:participant_removed', {
      userId: targetUserId,
      removedBy: userId,
    });

    // Kick the removed rider's socket(s) out of the room so they receive no
    // further updates for this ride.
    try {
      const sockets = await getIO().in(`ride:${rideId}`).fetchSockets();
      for (const s of sockets) {
        if (s.data.userId === targetUserId) s.leave(`ride:${rideId}`);
      }
    } catch {
      // Socket.IO not initialized (e.g. tests) — DB update + broadcast still applied.
    }

    return { ok: true };
  });

  // POST /rides/:rideId/join
  fastify.post('/rides/:rideId/join', {
    schema: {
      security,
      summary: 'Join a ride',
      headers: deviceIdHeaderSchema,
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: participationDeniedSchema,
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

    const quota = await canUserParticipate(userId, readDeviceId(request.headers));
    if (!quota.allowed) {
      return reply.code(403).send(participationDenied(quota));
    }

    if (existing) {
      // Re-joining after LEFT
      await updateParticipantStatus(rideId, userId, 'JOINED');
    } else {
      await addParticipant(rideId, userId);
    }

    captureReq(request, userId, 'ride_joined', {
      rider_count: current + 1,
      rejoin: !!existing,
      plan: quota.plan.code,
    });

    return { ok: true };
  });

  // POST /rides/:rideId/leave — a rider removes THEMSELVES from the ride
  //
  // Deliberately mirrors `DELETE /rides/:rideId/participants/:targetUserId` (the leader's kick)
  // rather than the older `ride:leave` socket event: same guards, same in-memory cleanup, same
  // broadcast, and an acknowledged HTTP result so the client knows whether it actually left
  // before it tears its own session down.
  fastify.post('/rides/:rideId/leave', {
    schema: {
      security,
      summary: 'Leave a ride (any participant except the leader)',
      tags: ['Rides'],
      params: {
        type: 'object',
        properties: { rideId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: errorSchema('LEADER_CANNOT_LEAVE'),
        404: errorSchema('RIDE_NOT_FOUND | PARTICIPANT_NOT_FOUND'),
        409: errorSchema('RIDE_ENDED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.status === 'COMPLETED') return reply.code(409).send({ error: 'RIDE_ENDED' });
    // The leader leaving would orphan the ride — nobody could start, end or edit it. They
    // delete it (DELETE /rides/:rideId) or end it instead.
    if (ride.leader_id === userId) {
      return reply.code(400).send({ error: 'LEADER_CANNOT_LEAVE' });
    }

    const me = await getParticipant(rideId, userId);
    if (!me || me.status === 'LEFT') {
      return reply.code(404).send({ error: 'PARTICIPANT_NOT_FOUND' });
    }

    await updateParticipantStatus(rideId, userId, 'LEFT');
    captureReq(request, userId, 'ride_left', { ride_status: ride.status });

    // DELETE from the live state, don't just flag it. `buildStatePayload` maps every entry in
    // `state.participants` with no status filter, so a participant merely marked LEFT keeps
    // broadcasting their last position to everyone else — their map pin, their rider marker and
    // their off-screen edge indicator would all survive the leave. This is exactly what the
    // socket `ride:leave` handler used to get wrong.
    const state = rideStore.get(rideId);
    if (state) {
      state.participants.delete(userId);
      // Recompute now so the payload below carries a leaderboard without them, rather than
      // shipping a stale one that the next location tick happens to correct.
      runLeaderboardEngine(state);
    }

    // Roster event first: this is what every client already listens to for live roster,
    // ready-tally and `canStart` updates.
    getIO().to(`ride:${rideId}`).emit('ride:participant_left', { userId });

    // Then the live snapshot, so riders already in navigation drop the pin, the leaderboard row
    // and the live count on the next frame instead of waiting for the next broadcast tick.
    if (state) {
      getIO().to(`ride:${rideId}`).emit('ride:state_update', buildStatePayload(state));
    }

    // Kick their socket(s) out of the room so they receive no further updates for this ride.
    try {
      const sockets = await getIO().in(`ride:${rideId}`).fetchSockets();
      for (const s of sockets) {
        if (s.data.userId === userId) s.leave(`ride:${rideId}`);
      }
    } catch {
      // Socket.IO not initialized (e.g. tests) — DB update + broadcast still applied.
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
      maxLeaderProgress: 0,
      detourMeters: 0,
      lastLeaderPoint: null,
      leaderRawMeters: 0,
      movingSeconds: 0,
      lastLeaderTs: null,
      maxGroupSplitMeters: 0,
      openRegroups: new Map(),
      openEmergencies: new Map(),
    };

    rideStore.set(rideId, state);

    captureReq(request, userId, 'ride_started', {
      rider_count: participantMap.size,
      distance_km: km(ride.distance_meters),
      // Lobby dwell: how long the leader took from creating the ride to setting off.
      lobby_minutes: ride.created_at ? Math.round((Date.now() - new Date(ride.created_at).getTime()) / 60_000) : undefined,
    });

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

    if (state && ride.started_at) {
      await generateRideSummary(rideId, ride.started_at, endedAt, state);
    } else if (ride.started_at) {
      // In-memory state lost (server restart). Create a fallback summary from DB data.
      await generateFallbackSummary(
        rideId, ride.leader_id, ride.started_at, endedAt, ride.distance_meters
      );
    }

    captureReq(request, userId, 'ride_ended', {
      duration_min: ride.started_at ? Math.round((endedAt.getTime() - new Date(ride.started_at).getTime()) / 60_000) : undefined,
      rider_count: state?.participants.size,
      distance_km: km(state ? state.maxLeaderProgress + state.detourMeters : ride.distance_meters),
      max_split_km: state ? km(state.maxGroupSplitMeters) : undefined,
      server_state_lost: !state,
    });

    // One per rider still in the ride, so "took part in a ride" is measurable for joiners too
    // (ride_ended is the leader's alone). Best-effort: it must never fail the end of a ride.
    try {
      const riders = (await getParticipantsWithUsers(rideId)).filter((p) => p.status !== 'LEFT');
      const durationMin = ride.started_at
        ? Math.round((endedAt.getTime() - new Date(ride.started_at).getTime()) / 60_000)
        : undefined;
      for (const r of riders) {
        capture(r.user_id, 'ride_completed', {
          duration_min: durationMin,
          rider_count: riders.length,
          is_leader: r.user_id === ride.leader_id,
        });
      }
    } catch (err) {
      request.log.warn({ err }, 'ride_completed analytics skipped');
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
            participants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  name: { type: 'string' },
                  avatarUrl: { type: 'string', nullable: true },
                  rideTitle: { type: 'string', nullable: true },
                  syncScore: { type: 'integer', nullable: true },
                },
              },
            },
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
