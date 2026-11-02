import { FastifyInstance, FastifyRequest } from 'fastify';
import { getRideById } from '../db/rideRepo';
import { getParticipant } from '../db/participantRepo';
import { listLeaderStops } from '../db/regroupRepo';
import {
  getOrCreateShareToken, disableShare, getSharedRoute, getSharedWaypoints,
} from '../db/shareRepo';
import { ipRateLimit } from '../middleware/rateLimit';
import { nearStart, publicActualPolyline, publicPolyline } from '../engines/routePrivacy';
import { captureReq } from '../services/analytics';

const security = [{ bearerAuth: [] }];
const SHARE_LINK_BASE = process.env.SHARE_LINK_BASE ?? 'https://convotrack.in/route';
const TOKEN_PATTERN = '^[A-HJKMNP-Z2-9]{10}$';
const errorSchema = (description: string) => ({
  type: 'object', description, properties: { error: { type: 'string' } },
});

/** Authenticated: create / revoke a ride's share link. */
export async function shareManagementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/rides/:rideId/share', {
    schema: {
      security,
      summary: 'Create (or fetch) the public share link for a completed ride',
      tags: ['Share'],
      params: { type: 'object', properties: { rideId: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: { token: { type: 'string' }, url: { type: 'string' } },
        },
        403: errorSchema('NOT_PARTICIPANT'),
        404: errorSchema('RIDE_NOT_FOUND'),
        409: errorSchema('RIDE_NOT_COMPLETED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };

    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    const me = await getParticipant(rideId, userId);
    if (!me || me.status === 'LEFT') return reply.code(403).send({ error: 'NOT_PARTICIPANT' });
    if (ride.status !== 'COMPLETED') return reply.code(409).send({ error: 'RIDE_NOT_COMPLETED' });

    const token = await getOrCreateShareToken(rideId);
    captureReq(request, userId, 'ride_route_shared', { is_leader: ride.leader_id === userId });
    return { token, url: `${SHARE_LINK_BASE}/${token}` };
  });

  fastify.delete('/rides/:rideId/share', {
    schema: {
      security,
      summary: 'Turn the share link off (leader only)',
      tags: ['Share'],
      params: { type: 'object', properties: { rideId: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: errorSchema('NOT_LEADER'),
        404: errorSchema('RIDE_NOT_FOUND'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { rideId } = request.params as { rideId: string };
    const ride = await getRideById(rideId);
    if (!ride) return reply.code(404).send({ error: 'RIDE_NOT_FOUND' });
    if (ride.leader_id !== userId) return reply.code(403).send({ error: 'NOT_LEADER' });
    await disableShare(rideId);
    return { ok: true };
  });
}

/** Public, unauthenticated: what a shared link resolves to. Route data only, never rider
 *  identities, the invite code or emergencies, and the start of the route is withheld. */
export async function sharedRouteRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/shared-routes/:token', {
    preHandler: ipRateLimit(60),
    schema: {
      summary: 'Public route data for a shared completed ride',
      tags: ['Share'],
      params: { type: 'object', properties: { token: { type: 'string', pattern: TOKEN_PATTERN } } },
      response: {
        200: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            plannedRoutePolyline: { type: 'string', nullable: true, description: 'Planned route, first 500 m withheld.' },
            actualRoutePolyline: { type: 'string', nullable: true, description: 'Route actually ridden, start (and a stray end) withheld. Null for older rides.' },
            distanceMeters: { type: 'number' },
            durationSeconds: { type: 'integer', nullable: true },
            destinationName: { type: 'string' },
            waypoints: {
              type: 'array',
              description: 'Stops after the start, in order. The START waypoint is never included.',
              items: {
                type: 'object',
                properties: {
                  order: { type: 'integer' }, name: { type: 'string' },
                  lat: { type: 'number' }, lng: { type: 'number' },
                  type: { type: 'string', enum: ['WAYPOINT', 'DESTINATION'] },
                },
              },
            },
            leaderStops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string', enum: ['FUEL', 'FOOD', 'SCENIC', 'STOP'] },
                  lat: { type: 'number' }, lng: { type: 'number' },
                },
              },
            },
            viaPoints: {
              type: 'array',
              description: 'One point per stretch where the leader left the planned route. Route a clone through these to follow the roads actually ridden.',
              items: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
            },
            riderCount: { type: 'integer' },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            sharedBy: {
              type: 'object', nullable: true,
              properties: { firstName: { type: 'string' } },
            },
          },
        },
        404: errorSchema('SHARE_NOT_FOUND'),
        429: errorSchema('RATE_LIMITED'),
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { token } = request.params as { token: string };
    const row = await getSharedRoute(token);
    if (!row) return reply.code(404).send({ error: 'SHARE_NOT_FOUND' });

    const [waypoints, stops] = await Promise.all([
      getSharedWaypoints(row.ride_id),
      listLeaderStops(row.ride_id),
    ]);
    const start = row.start_lat != null && row.start_lng != null
      ? { lat: row.start_lat, lng: row.start_lng } : null;
    const firstName = row.leader_name?.trim().split(/\s+/)[0];

    reply.header('Cache-Control', 'public, max-age=300');
    return {
      title: row.title,
      plannedRoutePolyline: publicPolyline(row.route_polyline),
      actualRoutePolyline: publicActualPolyline(
        row.actual_route_polyline, { lat: row.destination_lat, lng: row.destination_lng }
      ),
      distanceMeters: row.actual_distance_meters ?? row.distance_meters,
      durationSeconds: row.duration_seconds,
      destinationName: row.destination_name,
      waypoints,
      // A stop inside the withheld start zone would point straight at it.
      leaderStops: stops
        .filter((s) => !nearStart({ lat: s.lat, lng: s.lng }, start))
        .map((s) => ({ id: s.id, type: s.type, lat: s.lat, lng: s.lng })),
      viaPoints: (row.via_points ?? []).filter((v) => !nearStart(v, start)),
      riderCount: row.rider_count,
      endedAt: row.ended_at,
      sharedBy: firstName && firstName !== 'Unknown' ? { firstName } : null,
    };
  });
}
