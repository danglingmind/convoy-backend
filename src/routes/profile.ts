import { FastifyInstance, FastifyRequest } from 'fastify';
import { setUserAvatar, setUserName } from '../db/userRepo';
import { setClerkName, setClerkProfileImage } from '../services/clerkAdmin';
import { getIO } from '../sockets/server';

const security = [{ bearerAuth: [] }];
const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

/** What riders may call themselves. Long enough for "Firstname Middlename Lastname". */
export const NAME_MAX_LENGTH = 40;
/** The apps send a square JPEG of at most ~1024 px, far below this. */
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'];

/**
 * Rider-editable identity: the display name and profile photo other riders see.
 *
 * Clerk stays the source of truth for both, and that is the point of routing the edit through the
 * server rather than writing only the `users` row. Every client re-syncs name and photo from its
 * Clerk user on launch (`PATCH /users/me`), and session tokens carry Clerk's `imageUrl`; an edit
 * that lived only in Postgres would be overwritten by the next launch of any older app build.
 * Writing Clerk first, then the row, keeps every one of those paths agreeing with the edit.
 *
 * The admin API is used (not the client SDKs' own update calls) so the edit works regardless of
 * which profile fields the Clerk instance lets end users change.
 */
export async function profileRoutes(fastify: FastifyInstance): Promise<void> {
  // Raw image bodies. Parsed as a Buffer; the route checks the size and type.
  for (const type of PHOTO_TYPES) {
    fastify.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: PHOTO_MAX_BYTES }, (_req, body, done) => {
      done(null, body);
    });
  }

  // PUT /users/me/name — change the name other riders see
  fastify.put('/users/me/name', {
    schema: {
      security,
      summary: 'Change the display name other riders see',
      tags: ['Users'],
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', description: `1–${NAME_MAX_LENGTH} characters after trimming` } },
      },
      response: {
        200: { type: 'object', properties: { name: { type: 'string' } } },
        400: errorSchema,
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const name = normaliseName((request.body as { name: string }).name);
    if (!name) return reply.code(400).send({ error: 'NAME_REQUIRED' });
    if ([...name].length > NAME_MAX_LENGTH) return reply.code(400).send({ error: 'NAME_TOO_LONG' });

    await setClerkName(userId, name);
    await setUserName(userId, name);
    refreshLiveIdentity(userId, { name });
    return { name };
  });

  // PUT /users/me/photo — replace the profile photo
  fastify.put('/users/me/photo', {
    schema: {
      security,
      summary: 'Replace the profile photo other riders see',
      description: 'Body is the raw image (image/jpeg, image/png, image/heic or image/webp), at most 5 MB.',
      tags: ['Users'],
      consumes: PHOTO_TYPES,
      response: {
        200: { type: 'object', properties: { avatarUrl: { type: 'string' } } },
        400: errorSchema,
        413: errorSchema,
        415: errorSchema,
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!PHOTO_TYPES.includes(type)) return reply.code(415).send({ error: 'UNSUPPORTED_IMAGE_TYPE' });
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'IMAGE_REQUIRED' });

    const avatarUrl = await setClerkProfileImage(userId, body, type);
    await setUserAvatar(userId, avatarUrl);
    refreshLiveIdentity(userId, { avatarUrl });
    return { avatarUrl };
  });
}

/** Collapses runs of whitespace and trims; "" when nothing is left. */
export function normaliseName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Sockets capture name and avatar at connect and stamp them on later broadcasts (a rejoin's
 * `ride:participant_joined`). Update the rider's open sockets so a mid-ride edit isn't undone by
 * the next broadcast. Rosters fetched over REST read the row and are already current.
 */
function refreshLiveIdentity(userId: string, fields: { name?: string; avatarUrl?: string }): void {
  try {
    for (const socket of getIO().of('/').sockets.values()) {
      if (socket.data.userId !== userId) continue;
      if (fields.name !== undefined) socket.data.name = fields.name;
      if (fields.avatarUrl !== undefined) socket.data.avatarUrl = fields.avatarUrl;
    }
  } catch {
    // Socket.IO not initialised (spec generation, tests).
  }
}
