import { FastifyInstance, FastifyRequest } from 'fastify';
import { upsertDevice, deleteDevice } from '../db/deviceRepo';

const security = [{ bearerAuth: [] }];

export async function devicesRoutes(fastify: FastifyInstance): Promise<void> {
  // PUT /devices — register (or refresh) this device's push token.
  fastify.put('/devices', {
    schema: {
      security,
      summary: 'Register a push notification token for the caller',
      tags: ['Devices'],
      body: {
        type: 'object',
        required: ['token', 'platform'],
        properties: {
          token:      { type: 'string', minLength: 1, maxLength: 4096 },
          platform:   { type: 'string', enum: ['ios', 'android'] },
          locale:     { type: 'string', maxLength: 32 },
          appVersion: { type: 'string', maxLength: 32 },
        },
      },
      response: { 204: { type: 'null', description: 'Registered' } },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const b = request.body as { token: string; platform: 'ios' | 'android'; locale?: string; appVersion?: string };
    await upsertDevice(userId, b.token, b.platform, b.locale, b.appVersion);
    return reply.code(204).send();
  });

  // DELETE /devices/:token — unregister (sign-out). Only the caller's own token.
  fastify.delete('/devices/:token', {
    schema: {
      security,
      summary: "Unregister the caller's push notification token",
      tags: ['Devices'],
      params: {
        type: 'object',
        properties: { token: { type: 'string', minLength: 1, maxLength: 4096 } },
      },
      response: { 204: { type: 'null', description: 'Unregistered' } },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { token } = request.params as { token: string };
    await deleteDevice(userId, token);
    return reply.code(204).send();
  });
}
