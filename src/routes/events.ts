import { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db/pool';
import { readDeviceId, deviceIdHeaderSchema } from '../services/quotaService';

const security = [{ bearerAuth: [] }];

/** The upsell funnel. Anything else is rejected so the table stays queryable. */
const EVENT_NAMES = [
  'paywall_shown',            // paywall opened (source = where from)
  'paywall_purchase_started', // rider tapped the purchase button
  'paywall_converted',        // purchase completed and Pro is active
  'paywall_dismissed',        // paywall closed without buying
  'nudge_shown',              // app-open nudge presented
  'nudge_dismissed',          // nudge closed with "Not now" / swipe
  'home_card_dismissed',      // Home Pro card snoozed
] as const;

const MAX_EVENTS = 50;

interface IncomingEvent {
  name: string;
  source?: string;
  access?: string;
  occurredAt: string;
}

export async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /events — batched, fire-and-forget funnel events from the apps.
  fastify.post('/events', {
    schema: {
      security,
      summary: 'Record paywall / upsell funnel events',
      tags: ['Events'],
      headers: deviceIdHeaderSchema,
      body: {
        type: 'object',
        required: ['platform', 'events'],
        properties: {
          platform:   { type: 'string', enum: ['ios', 'android'] },
          appVersion: { type: 'string', maxLength: 32 },
          events: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EVENTS,
            items: {
              type: 'object',
              required: ['name', 'occurredAt'],
              properties: {
                name:       { type: 'string', enum: [...EVENT_NAMES] },
                source:     { type: 'string', maxLength: 32 },
                access:     { type: 'string', enum: ['pro', 'trial', 'trialExpired', 'free'] },
                occurredAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      response: {
        200: { type: 'object', properties: { accepted: { type: 'integer' } } },
        400: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest) => {
    const { userId } = request.user;
    const body = request.body as { platform: string; appVersion?: string; events: IncomingEvent[] };
    const deviceId = readDeviceId(request.headers);

    // Client clocks drift; anything claiming to be from the future is stamped "now" instead.
    const now = Date.now();
    const rows = body.events.map((e) => {
      const at = Date.parse(e.occurredAt);
      return [userId, deviceId, e.name, e.source ?? null, e.access ?? null, body.platform,
        body.appVersion ?? null, new Date(Number.isFinite(at) && at <= now ? at : now)];
    });

    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(...r);
      const o = i * 8;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8})`;
    });
    await pool.query(
      `INSERT INTO paywall_events (user_id, device_id, name, source, access, platform, app_version, occurred_at)
       VALUES ${tuples.join(', ')}`,
      values
    );
    return { accepted: rows.length };
  });
}
