import { pool } from '../db/pool';
import { getUserPlan, getFreePlan, MembershipPlan } from '../db/membershipRepo';

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number | null;
  plan: MembershipPlan;
}

export async function getUserPlanOrFree(userId: string): Promise<MembershipPlan> {
  const plan = await getUserPlan(userId);
  return plan ?? getFreePlan();
}

export async function canUserParticipate(userId: string): Promise<QuotaResult> {
  const plan = await getUserPlanOrFree(userId);

  if (plan.monthly_ride_participation_limit === null) {
    return { allowed: true, used: 0, limit: null, plan };
  }

  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM ride_participants rp
     JOIN rides r ON r.id = rp.ride_id
     WHERE rp.user_id = $1
       AND rp.counted_toward_quota = true
       AND date_trunc('month', rp.quota_consumed_at) = date_trunc('month', now())`,
    [userId]
  );

  const used = parseInt(rows[0].count, 10);
  const limit = plan.monthly_ride_participation_limit;

  return {
    allowed: used < limit,
    used,
    limit,
    plan,
  };
}
