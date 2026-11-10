import { FastifyInstance, FastifyRequest } from 'fastify';
import { getPrefs, upsertPrefs } from '../db/notificationPrefsRepo';

const security = [{ bearerAuth: [] }];
const prefsSchema = {
  type: 'object',
  properties: { rideUpdates: { type: 'boolean' }, regroup: { type: 'boolean' } },
  required: ['rideUpdates', 'regroup'],
};

export async function notificationPrefsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/users/me/notification-preferences', {
    schema: {
      security,
      summary: "Get the caller's push notification preferences",
      tags: ['Devices'],
      response: { 200: prefsSchema },
    },
  }, async (request: FastifyRequest) => getPrefs(request.user.userId));

  fastify.put('/users/me/notification-preferences', {
    schema: {
      security,
      summary: "Update the caller's push notification preferences (partial)",
      tags: ['Devices'],
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { rideUpdates: { type: 'boolean' }, regroup: { type: 'boolean' } },
      },
      response: { 200: prefsSchema },
    },
  }, async (request: FastifyRequest) =>
    upsertPrefs(request.user.userId, request.body as { rideUpdates?: boolean; regroup?: boolean }));
}
