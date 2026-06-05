import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '@clerk/backend';
import { upsertUser } from '../db/userRepo';

export async function clerkAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
      authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES
        ? process.env.CLERK_AUTHORIZED_PARTIES.split(',')
        : [],
    });
    const firstName = (payload as Record<string, unknown>)['firstName'] as string | undefined;
    const lastName = (payload as Record<string, unknown>)['lastName'] as string | undefined;
    const imageUrl = (payload as Record<string, unknown>)['imageUrl'] as string | undefined;

    const name =
      [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown';
    const avatarUrl = imageUrl ?? null;

    request.user = { userId: payload.sub, name, avatarUrl };

    await upsertUser(payload.sub, name, avatarUrl);
  } catch (err) {
    request.log.warn({ err }, 'Clerk token verification failed');
    reply.code(401).send({ error: 'INVALID_TOKEN' });
  }
}
