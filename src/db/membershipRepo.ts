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

export async function upsertMembership(params: {
  userId: string;
  planId: string;
  startsAt: Date;
  endsAt: Date;
  appleOriginalTransactionId: string;
  appleProductId: string;
  appleEnvironment: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_memberships
       (user_id, plan_id, starts_at, ends_at,
        apple_original_transaction_id, apple_product_id, apple_environment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (apple_original_transaction_id)
     DO UPDATE SET
       ends_at            = EXCLUDED.ends_at,
       apple_environment  = EXCLUDED.apple_environment`,
    [
      params.userId,
      params.planId,
      params.startsAt,
      params.endsAt,
      params.appleOriginalTransactionId,
      params.appleProductId,
      params.appleEnvironment,
    ]
  );
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
