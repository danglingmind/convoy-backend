import { Server } from 'socket.io';
import { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { verifyToken } from '@clerk/backend';
import { upsertUser } from '../db/userRepo';
import { setupSocketHandlers } from './handlers';

let io: Server | null = null;

export function initSocketServer(
  httpServer: HttpServer<typeof IncomingMessage, typeof ServerResponse>
): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS ?? '*',
      methods: ['GET', 'POST'],
    },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
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

      const name =
        [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown';
      const avatarUrl = imageUrl ?? null;

      socket.data.userId = payload.sub;
      socket.data.name = name;
      socket.data.avatarUrl = avatarUrl;

      await upsertUser(payload.sub, name, avatarUrl);
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  setupSocketHandlers(io);

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}
