import { FastifyReply, FastifyRequest } from 'fastify';

/** Tiny fixed-window per-IP limiter for the unauthenticated endpoints. In-memory is enough:
 *  one instance, and the goal is only to blunt token guessing and scraping. */
export function ipRateLimit(maxPerWindow: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    const h = hits.get(request.ip);
    if (!h || h.resetAt <= now) {
      hits.set(request.ip, { count: 1, resetAt: now + windowMs });
      return;
    }
    h.count += 1;
    if (h.count > maxPerWindow) {
      reply.code(429).send({ error: 'RATE_LIMITED' });
    }
  };
}
