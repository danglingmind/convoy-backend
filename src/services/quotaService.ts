import { pool } from '../db/pool';
import { getUserPlan, getFreePlan, MembershipPlan } from '../db/membershipRepo';
import {
  getTrialEndsAt,
  startTrialIfUnset,
  startTrialAtIfUnset,
  getDeviceTrialEndsAt,
  recordDeviceTrial,
} from '../db/userRepo';

/** Length of the app-level free trial a new (or, at rollout, existing) rider gets. */
export const TRIAL_DURATION_DAYS = 3;

/**
 * Off until the iOS and Android builds that understand `TRIAL_EXPIRED` are live. Read per call so
 * flipping the env var on Render takes effect on the next restart without a code change.
 */
export function isTrialEnforced(): boolean {
  return process.env.TRIAL_ENFORCEMENT_ENABLED === 'true';
}

export interface TrialStatus {
  endsAt: Date | null;
  isActive: boolean;
  enforced: boolean;
}

export type QuotaDenial = 'TRIAL_EXPIRED' | 'QUOTA_EXCEEDED';

export interface QuotaResult {
  allowed: boolean;
  /** Why `allowed` is false; null when allowed. */
  reason: QuotaDenial | null;
  used: number;
  limit: number | null;
  plan: MembershipPlan;
  trial: TrialStatus;
}

export async function getUserPlanOrFree(userId: string): Promise<MembershipPlan> {
  const plan = await getUserPlan(userId);
  return plan ?? getFreePlan();
}

export function isPremiumPlan(plan: MembershipPlan): boolean {
  return plan.code !== 'free';
}

/** Route-schema fragment documenting the optional device header (one trial per device). */
export const deviceIdHeaderSchema = {
  type: 'object',
  properties: {
    'x-device-id': {
      type: 'string',
      description: 'Opaque app device id (16–128 chars, [A-Za-z0-9-]). Ties the free trial to the device.',
    },
  },
} as const;

/**
 * The app's opaque device id from the `X-Device-Id` header, or null when absent or malformed
 * (old app builds send none; the trial then falls back to per-account, as before).
 */
export function readDeviceId(headers: Record<string, unknown>): string | null {
  const raw = headers['x-device-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9-]{16,128}$/.test(value) ? value : null;
}

/**
 * Start a free rider's trial, one per device: a device that already had a trial (under any
 * account) hands its end date to the new account rather than granting 3 fresh days.
 */
async function startTrial(userId: string, deviceId: string | null): Promise<Date | null> {
  const existing = await getTrialEndsAt(userId);
  if (existing) {
    // Already running: just make sure this device remembers it for any later account.
    if (deviceId) await recordDeviceTrial(deviceId, userId, existing);
    return existing;
  }
  const deviceEnd = deviceId ? await getDeviceTrialEndsAt(deviceId) : null;
  const endsAt = deviceEnd
    ? await startTrialAtIfUnset(userId, deviceEnd)
    : await startTrialIfUnset(userId, TRIAL_DURATION_DAYS);
  if (deviceId && endsAt) await recordDeviceTrial(deviceId, userId, endsAt);
  return endsAt;
}

/**
 * The rider's trial. While enforcement is on, a free rider's trial starts on first sight; Pro riders
 * never start one (it would only be a misleading countdown if they later lapse).
 */
export async function getTrialStatus(
  userId: string,
  plan: MembershipPlan,
  deviceId: string | null = null,
): Promise<TrialStatus> {
  const enforced = isTrialEnforced();
  const endsAt = enforced && !isPremiumPlan(plan)
    ? await startTrial(userId, deviceId)
    : await getTrialEndsAt(userId);
  return {
    endsAt,
    isActive: endsAt !== null && endsAt.getTime() > Date.now(),
    enforced,
  };
}

/**
 * Whether the rider may create or join a ride. A free rider needs an unexpired trial (when
 * enforced) AND monthly quota left; the trial is checked first because it is the primary limit.
 */
export async function canUserParticipate(userId: string, deviceId: string | null = null): Promise<QuotaResult> {
  const plan = await getUserPlanOrFree(userId);
  const trial = await getTrialStatus(userId, plan, deviceId);
  const limit = plan.monthly_ride_participation_limit;
  const trialExpired = trial.enforced && !isPremiumPlan(plan) && !trial.isActive;

  if (limit === null) {
    const reason = trialExpired ? 'TRIAL_EXPIRED' : null;
    return { allowed: reason === null, reason, used: 0, limit: null, plan, trial };
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

  let reason: QuotaDenial | null = null;
  if (trialExpired) reason = 'TRIAL_EXPIRED';
  else if (used >= limit) reason = 'QUOTA_EXCEEDED';

  return { allowed: reason === null, reason, used, limit, plan, trial };
}
