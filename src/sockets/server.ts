import { Server } from 'socket.io';
import { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { verifyToken } from '@clerk/backend';
import { upsertUser, getUserById } from '../db/userRepo';
import { setupSocketHandlers } from './handlers';
import { startPresenceSweeper } from './presence';

let io: Server | null = null;

export function initSocketServer(
  httpServer: HttpServer<typeof IncomingMessage, typeof ServerResponse>
): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS ?? '*',
      methods: ['GET', 'POST'],
    },
    // Detect dead connections (killed app, dropped network) quickly so presence dots
    // don't linger green. A missed pong within pingTimeout of a ping fires 'disconnect'
    // (→ ride:participant_offline). ~10s interval + 10s timeout ⇒ offline within ~20s.
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth;
    const query = socket.handshake.query;
    console.log('[socket:auth] handshake.auth =', JSON.stringify(auth));
    console.log('[socket:auth] handshake.query keys =', Object.keys(query));

    const token = auth?.token as string | undefined;
    if (!token) {
      console.warn('[socket:auth] REJECTED — no token in handshake.auth');
      return next(new Error('UNAUTHORIZED'));
    }
    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY!,
      });
      const claims = payload as Record<string, unknown>;
      const firstName = claims['firstName'] as string | undefined;
      const lastName = claims['lastName'] as string | undefined;
      const imageUrl = claims['imageUrl'] as string | undefined;

      const jwtName = [firstName, lastName].filter(Boolean).join(' ').trim();
      const avatarUrl = imageUrl ?? null;

      // The DB name is authoritative (synced via REST /users/me). Clerk session tokens
      // often omit firstName/lastName claims, which previously made socket broadcasts
      // (participant_joined) fall back to "Unknown". Prefer the DB name so riders always
      // see the correct name live — no need to reopen the ride to fix it.
      const dbUser = await getUserById(payload.sub).catch(() => null);
      const dbName = dbUser?.name?.trim();
      const name = (dbName && dbName !== 'Unknown' ? dbName : jwtName) || 'Unknown';

      socket.data.userId = payload.sub;
      socket.data.name = name;
      socket.data.avatarUrl = avatarUrl;

      console.log(`[socket:auth] OK — userId=${payload.sub} name="${name}"`);
      // Seed a row for brand-new users; upsert never overwrites an existing name.
      if (!dbUser) await upsertUser(payload.sub, name, avatarUrl);
      next();
    } catch (err) {
      console.error('[socket:auth] REJECTED — token verification failed:', err);
      next(new Error('INVALID_TOKEN'));
    }
  });

  setupSocketHandlers(io);
  startPresenceSweeper(io);

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}
