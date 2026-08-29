import { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getUserById } from '../db/userRepo';
import {
  getUserPlan,
  getFreePlan,
  getPremiumPlan,
  upsertMembership,
  MembershipPlan,
  MembershipProvider,
} from '../db/membershipRepo';
import {
  verifyPlayPurchase,
  acknowledgePlayPurchase,
  isPlayConfigured,
  PlayNotConfiguredError,
  PlayPurchaseInvalidError,
} from '../services/playBillingService';

const security = [{ bearerAuth: [] }];

// Valid ConvoTrack IAP product IDs — reject any verified purchase for a different app's product.
// Legacy `convoy.*` IDs are kept so purchases made before the Convoy → ConvoTrack rename still activate.
// The two stores have separate namespaces and are checked separately: an Apple product id presented
// on the Play path is just as wrong as an unrecognised one.
const VALID_PRODUCT_IDS: Record<MembershipProvider, Set<string>> = {
  apple: new Set([
    'danglingmind.convotrack.membership.monthly',
    'danglingmind.convotrack.membership.yearly',
    'danglingmind.convoy.membership.monthly',
    'danglingmind.convoy.membership.yearly',
  ]),
  google: new Set([
    'convotrack_pro_monthly',
    'convotrack_pro_yearly',
  ]),
};

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
            userId:               { type: 'string' },
            name:                 { type: 'string' },
            avatarUrl:            { type: 'string', nullable: true },
            username:             { type: 'string', nullable: true },
            phone:                { type: 'string', nullable: true },
            phoneVisible:         { type: 'boolean' },
            emailContact:         { type: 'string', nullable: true },
            emailContactVisible:  { type: 'boolean' },
            notifyNearbyRides:    { type: 'boolean' },
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
    return {
      userId:              user.id,
      name:                user.name,
      avatarUrl:           user.avatar_url,
      username:            user.username,
      phone:               user.phone,
      phoneVisible:        user.phone_visible,
      emailContact:        user.email_contact,
      emailContactVisible: user.email_contact_visible,
      notifyNearbyRides:   user.notify_nearby_rides,
      plan:                planResponse(plan),
    };
  });

  // POST /memberships/activate — verify a store purchase and upgrade the user.
  //
  // Two shapes, one response. iOS posts `{ signedTransaction }` and is verified
  // offline against Apple's JWKS; Android posts `{ provider: 'google',
  // purchaseToken }` and is verified by asking the Play Developer API. `provider`
  // is optional and defaults to `apple` so the existing iOS build — which has no
  // idea this field exists — keeps working byte-for-byte.
  fastify.post('/memberships/activate', {
    schema: {
      security,
      summary: 'Activate premium membership from an Apple or Google Play purchase',
      tags: ['Memberships'],
      body: {
        type: 'object',
        properties: {
          provider:          { type: 'string', enum: ['apple', 'google'] },
          signedTransaction: { type: 'string' },
          purchaseToken:     { type: 'string' },
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
        409: { type: 'object', properties: { error: { type: 'string' } } },
        502: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply) => {
    const { userId } = request.user;
    const body = request.body as {
      provider?: MembershipProvider;
      signedTransaction?: string;
      purchaseToken?: string;
    };

    // Infer the provider from the payload when it is absent, so the existing iOS
    // request stays valid without a client change.
    const provider: MembershipProvider =
      body.provider ?? (body.purchaseToken ? 'google' : 'apple');

    let productId:   string;
    let expiresDate: Date;
    let purchaseAt:  Date;
    let environment: string;
    let transactionId: string;

    if (provider === 'apple') {
      if (!body.signedTransaction) {
        return reply.code(400).send({ error: 'MISSING_REQUIRED_FIELDS' });
      }

      let payload: AppleJWSPayload;
      try {
        payload = await verifyAppleJWS(body.signedTransaction);
      } catch {
        return reply.code(400).send({ error: 'INVALID_TRANSACTION' });
      }

      if (!payload.originalTransactionId || !payload.expiresDate) {
        return reply.code(400).send({ error: 'INVALID_TRANSACTION_PAYLOAD' });
      }

      productId     = payload.productId;
      transactionId = payload.originalTransactionId;
      expiresDate   = new Date(payload.expiresDate);
      purchaseAt    = new Date(payload.purchaseDate ?? Date.now());
      environment   = payload.environment ?? 'Production';

    } else {
      if (!body.purchaseToken) {
        return reply.code(400).send({ error: 'MISSING_REQUIRED_FIELDS' });
      }
      if (!isPlayConfigured()) {
        // Distinct from a bad purchase: the rider did nothing wrong and retrying
        // will not help until the service account is configured.
        request.log.error('Play activation attempted but GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is unset');
        return reply.code(502).send({ error: 'PLAY_VERIFICATION_UNAVAILABLE' });
      }

      let purchase;
      try {
        purchase = await verifyPlayPurchase(body.purchaseToken);
      } catch (err) {
        if (err instanceof PlayPurchaseInvalidError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof PlayNotConfiguredError) {
          return reply.code(502).send({ error: 'PLAY_VERIFICATION_UNAVAILABLE' });
        }
        // Google was unreachable or answered 5xx. Not the rider's fault, and the
        // client should retry rather than treat the purchase as dead.
        request.log.error({ err }, 'Play purchase verification failed');
        return reply.code(502).send({ error: 'PLAY_VERIFICATION_UNAVAILABLE' });
      }

      productId   = purchase.productId;
      expiresDate = purchase.expiresAt;
      purchaseAt  = purchase.startsAt;
      environment = purchase.environment;
      // Play reissues the token on upgrade/downgrade and points the new one at
      // the old via linkedPurchaseToken. Keying on the *original* token keeps a
      // plan change updating one row instead of stacking a second entitlement.
      transactionId = purchase.linkedPurchaseToken ?? body.purchaseToken;
    }

    if (!VALID_PRODUCT_IDS[provider].has(productId)) {
      return reply.code(400).send({ error: 'INVALID_PRODUCT_ID' });
    }

    if (process.env.NODE_ENV === 'production' && environment === 'Sandbox') {
      return reply.code(400).send({ error: 'SANDBOX_TRANSACTION_IN_PRODUCTION' });
    }

    if (expiresDate <= new Date()) {
      return reply.code(400).send({ error: 'TRANSACTION_EXPIRED' });
    }

    const premiumPlan = await getPremiumPlan();

    const owner = await upsertMembership({
      userId,
      planId: premiumPlan.id,
      startsAt: purchaseAt,
      endsAt: expiresDate,
      provider,
      providerTransactionId: transactionId,
      // Use the product id from the verified purchase, not the client-supplied body
      providerProductId: productId,
      providerEnvironment: environment,
    });

    // The purchase is already bound to a different account. Reporting premium
    // here would hand the caller a plan that `GET /users/me` will not agree with,
    // so say so instead of returning a 200 the server cannot honour.
    if (owner.userId !== userId) {
      return reply.code(409).send({ error: 'PURCHASE_ALREADY_CLAIMED' });
    }

    if (provider === 'google' && body.purchaseToken) {
      // After the entitlement is durable, never before — an acknowledgement that
      // outlives a failed write would leave a paid rider on the free plan with no
      // refund window left. Best-effort: Play retries for three days.
      try {
        await acknowledgePlayPurchase(body.purchaseToken, productId);
      } catch (err) {
        request.log.warn({ err }, 'Play purchase acknowledgement failed');
      }
    }

    return { ok: true, plan: planResponse(premiumPlan, expiresDate) };
  });
}
