import { pool } from './pool';

export interface MembershipPlan {
  id: string;
  code: string;
  monthly_ride_participation_limit: number | null;
  max_riders_per_ride: number;
  ride_history_days: number;
  replay_enabled: boolean;
  analytics_enabled: boolean;
}

export async function getUserPlan(userId: string): Promise<MembershipPlan | null> {
  const { rows } = await pool.query<MembershipPlan>(
    `SELECT mp.id, mp.code, mp.monthly_ride_participation_limit,
            mp.max_riders_per_ride, mp.ride_history_days,
            mp.replay_enabled, mp.analytics_enabled
     FROM user_memberships um
     JOIN membership_plans mp ON mp.id = um.plan_id
     WHERE um.user_id = $1
       AND um.starts_at <= now()
       AND (um.ends_at IS NULL OR um.ends_at > now())
     ORDER BY um.starts_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** A store we can actually verify a purchase against. */
export type MembershipProvider = 'apple' | 'google';

/**
 * Record a verified subscription purchase, keyed on the purchase itself rather
 * than on the user, so that replaying the same transaction — which both stores
 * do on every app launch — refreshes the existing row instead of stacking up
 * duplicates.
 *
 * Returns the user the purchase is bound to. That is *not* always the caller:
 * the row keeps whichever account first claimed the purchase, so the route can
 * tell a genuine renewal apart from a second account presenting someone else's
 * transaction, and refuse to report premium to an account that will not get it.
 *
 * The legacy `apple_*` columns are written alongside the generic ones for Apple
 * purchases. They are redundant for reads, but keeping them populated means the
 * previous build can be redeployed against this schema without losing rows.
 */
export async function upsertMembership(params: {
  userId: string;
  planId: string;
  startsAt: Date;
  endsAt: Date;
  provider: MembershipProvider;
  providerTransactionId: string;
  providerProductId: string;
  providerEnvironment: string;
}): Promise<{ userId: string }> {
  const { rows } = await pool.query<{ user_id: string }>(
    `INSERT INTO user_memberships
       (user_id, plan_id, starts_at, ends_at,
        provider, provider_transaction_id, provider_product_id, provider_environment,
        apple_original_transaction_id, apple_product_id, apple_environment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $5 = 'apple' THEN $6 END,
             CASE WHEN $5 = 'apple' THEN $7 END,
             CASE WHEN $5 = 'apple' THEN $8 END)
     ON CONFLICT (provider, provider_transaction_id)
       WHERE provider IS NOT NULL AND provider_transaction_id IS NOT NULL
     DO UPDATE SET
       plan_id                 = EXCLUDED.plan_id,
       ends_at                 = EXCLUDED.ends_at,
       provider_product_id     = EXCLUDED.provider_product_id,
       provider_environment    = EXCLUDED.provider_environment,
       apple_product_id        = EXCLUDED.apple_product_id,
       apple_environment       = EXCLUDED.apple_environment
     RETURNING user_id`,
    [
      params.userId,
      params.planId,
      params.startsAt,
      params.endsAt,
      params.provider,
      params.providerTransactionId,
      params.providerProductId,
      params.providerEnvironment,
    ]
  );
  return { userId: rows[0].user_id };
}

export async function getFreePlan(): Promise<MembershipPlan> {
  const { rows } = await pool.query<MembershipPlan>(
    `SELECT id, code, monthly_ride_participation_limit,
            max_riders_per_ride, ride_history_days,
            replay_enabled, analytics_enabled
     FROM membership_plans
     WHERE code = 'free'`
  );
  if (!rows[0]) throw new Error('Free plan not found — run migrations');
  return rows[0];
}

export async function getPremiumPlan(): Promise<MembershipPlan> {
  const { rows } = await pool.query<MembershipPlan>(
    `SELECT id, code, monthly_ride_participation_limit,
            max_riders_per_ride, ride_history_days,
            replay_enabled, analytics_enabled
     FROM membership_plans
     WHERE code = 'premium'`
  );
  if (!rows[0]) throw new Error('Premium plan not found — run migrations');
  return rows[0];
}
