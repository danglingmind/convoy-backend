import { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getUserById } from '../db/userRepo';
import {
  getUserPlan,
  getFreePlan,
  getPremiumPlan,
  upsertMembership,
  MembershipPlan,
} from '../db/membershipRepo';

const security = [{ bearerAuth: [] }];

// Apple's public JWKS endpoint — keys are cached internally by jose with TTL.
const appleJWKS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys')
);

interface AppleJWSPayload {
  productId: string;
  originalTransactionId: string;
  expiresDate: number;    // Unix ms
  purchaseDate: number;   // Unix ms
  environment: string;    // 'Sandbox' | 'Production'
}

// Verify and decode a StoreKit 2 signed transaction.
// Uses Apple's JWKS to verify the ES256 signature — rejects forged tokens.
async function verifyAppleJWS(jws: string): Promise<AppleJWSPayload> {
  const { payload } = await jwtVerify(jws, appleJWKS, {
    algorithms: ['ES256'],
  });
  return payload as unknown as AppleJWSPayload;
}

function planResponse(plan: MembershipPlan, endsAt?: Date) {
  return {
    code: plan.code,
    isPremium: plan.code !== 'free',
    maxRidersPerRide: plan.max_riders_per_ride,
    monthlyLimit: plan.monthly_ride_participation_limit,
    rideHistoryDays: plan.ride_history_days,
    analyticsEnabled: plan.analytics_enabled,
    ...(endsAt ? { endsAt: endsAt.toISOString() } : {}),
  };
}

export async function membershipRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /users/me — current user profile + active plan
  fastify.get('/users/me', {
    schema: {
      security,
      summary: 'Get current user profile and membership plan',
      tags: ['Users'],
      response: {
        200: {
          type: 'object',
          properties: {
            userId:    { type: 'string' },
            name:      { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
            plan: {
              type: 'object',
              properties: {
                code:             { type: 'string' },
                isPremium:        { type: 'boolean' },
                maxRidersPerRide: { type: 'integer' },
                monthlyLimit:     { type: 'integer', nullable: true },
                rideHistoryDays:  { type: 'integer' },
                analyticsEnabled: { type: 'boolean' },
              },
            },
          },
        },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const [user, activePlan] = await Promise.all([
      getUserById(userId),
      getUserPlan(userId),
    ]);
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const plan = activePlan ?? await getFreePlan();
    return { userId: user.id, name: user.name, avatarUrl: user.avatar_url, plan: planResponse(plan) };
  });

  // POST /memberships/activate — verify Apple IAP signed transaction and upgrade user
  fastify.post('/memberships/activate', {
    schema: {
      security,
      summary: 'Activate premium membership from Apple IAP signed transaction',
      tags: ['Memberships'],
      body: {
        type: 'object',
        required: ['signedTransaction'],
        properties: {
          signedTransaction: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            plan: {
              type: 'object',
              properties: {
                code:             { type: 'string' },
                isPremium:        { type: 'boolean' },
                maxRidersPerRide: { type: 'integer' },
                monthlyLimit:     { type: 'integer', nullable: true },
                rideHistoryDays:  { type: 'integer' },
                analyticsEnabled: { type: 'boolean' },
                endsAt:           { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const { signedTransaction } = request.body as { signedTransaction: string };

    let payload: AppleJWSPayload;
    try {
      payload = await verifyAppleJWS(signedTransaction);
    } catch {
      return reply.code(400).send({ error: 'INVALID_TRANSACTION' });
    }

    if (!payload.originalTransactionId || !payload.expiresDate) {
      return reply.code(400).send({ error: 'INVALID_TRANSACTION_PAYLOAD' });
    }

    const endsAt = new Date(payload.expiresDate);
    if (endsAt <= new Date()) {
      return reply.code(400).send({ error: 'TRANSACTION_EXPIRED' });
    }

    const premiumPlan = await getPremiumPlan();
    const startsAt    = new Date(payload.purchaseDate ?? Date.now());

    await upsertMembership({
      userId,
      planId: premiumPlan.id,
      startsAt,
      endsAt,
      appleOriginalTransactionId: payload.originalTransactionId,
      // Use productId from the verified JWS payload, not the client-supplied body
      appleProductId: payload.productId,
      appleEnvironment: payload.environment ?? 'Production',
    });

    return { ok: true, plan: planResponse(premiumPlan, endsAt) };
  });
}
