import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { clerkAuth } from './middleware/auth';
import { healthRoutes } from './routes/health';
import { ridesRoutes } from './routes/rides';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
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

  // Protected routes
  await fastify.register(async (protected_) => {
    protected_.addHook('preHandler', clerkAuth);
    await protected_.register(ridesRoutes);
  });

  // Global error handler
  fastify.setErrorHandler((err, _request, reply) => {
    fastify.log.error(err);
    reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR' });
  });

  return fastify;
}
