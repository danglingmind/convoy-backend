import { AuthUser } from './index';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}
