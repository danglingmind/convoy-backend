import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { clerkAuth } from './middleware/auth';
import { healthRoutes } from './routes/health';
import { deeplinkRoutes } from './routes/deeplink';
import { ridesRoutes } from './routes/rides';
import { eventsRoutes } from './routes/events';
import { devicesRoutes } from './routes/devices';
import { notificationPrefsRoutes } from './routes/notificationPrefs';
import { membershipRoutes } from './routes/memberships';
import { profileRoutes } from './routes/profile';
import { shareManagementRoutes, sharedRouteRoutes } from './routes/sharedRoutes';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    // Behind Render's proxy: makes request.ip the rider's address (X-Forwarded-For), not the proxy's.
    trustProxy: true,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Convoy API',
        description: 'Motorcycle convoy ride coordination backend',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Clerk JWT token',
          },
        },
      },
    },
  });

  await fastify.register(cors, {
    origin: process.env.ALLOWED_ORIGINS ?? '*',
  });

  // Public routes (no auth)
  await fastify.register(healthRoutes);
  await fastify.register(deeplinkRoutes);
  await fastify.register(sharedRouteRoutes);

  // Protected routes
  await fastify.register(async (protected_) => {
    protected_.addHook('preHandler', clerkAuth);
    await protected_.register(ridesRoutes);
    await protected_.register(membershipRoutes);
    await protected_.register(eventsRoutes);
    await protected_.register(devicesRoutes);
    await protected_.register(notificationPrefsRoutes);
    await protected_.register(profileRoutes);
    await protected_.register(shareManagementRoutes);
  });

  // Global error handler
  fastify.setErrorHandler((err, _request, reply) => {
    fastify.log.error(err);
    reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR' });
  });

  return fastify;
}
