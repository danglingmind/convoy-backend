/**
 * Which APNs host a device token belongs to. Xcode / simulator builds register sandbox tokens,
 * TestFlight / App Store builds register production tokens, and APNs answers `BadDeviceToken`
 * when a token is sent to the other host. Pure logic (no network) so it can be unit tested.
 */
export type ApnsEnv = 'production' | 'sandbox';

export interface ApnsAnswer {
  status: number;
  text: string;
}

export type ApnsOutcome = 'sent' | 'dead' | 'wrong-env' | 'error';

export function classify(answer: ApnsAnswer): ApnsOutcome {
  if (answer.status === 200) return 'sent';
  // Only these remove a token. A BadDeviceToken never does: it only means "wrong host".
  if (answer.status === 410 || answer.text.includes('Unregistered')) return 'dead';
  if (answer.text.includes('BadDeviceToken')) return 'wrong-env';
  return 'error';
}

/** Hosts to try, in order. Production first unless the deployment is explicitly sandbox. */
export function hostOrder(configured: string | undefined, known?: ApnsEnv): ApnsEnv[] {
  const base: ApnsEnv[] = configured === 'sandbox' ? ['sandbox', 'production'] : ['production', 'sandbox'];
  if (!known) return base;
  return [known, ...base.filter((e) => e !== known)];
}

export interface DeliveryResult {
  outcome: ApnsOutcome;
  /** The host that answered conclusively (not a wrong-env miss); null when every host missed. */
  env: ApnsEnv | null;
  answer: ApnsAnswer;
}

/** Try each host in order, moving on only when the token is the wrong environment for that host. */
export async function deliver(
  order: ApnsEnv[],
  attempt: (env: ApnsEnv) => Promise<ApnsAnswer>
): Promise<DeliveryResult> {
  let last: ApnsAnswer = { status: 0, text: '' };
  for (const env of order) {
    last = await attempt(env);
    const outcome = classify(last);
    if (outcome !== 'wrong-env') return { outcome, env, answer: last };
  }
  return { outcome: 'wrong-env', env: null, answer: last };
}

/**
 * Provider-token errors that mean "mint a new JWT". Apple throttles minting to once per 20 minutes
 * (TooManyProviderTokenUpdates), so a refresh is only worthwhile for these, and only when the
 * cached token is old enough to be replaced.
 */
export const JWT_REFRESH_MIN_AGE_MS = 20 * 60_000;

export function shouldRefreshJwt(answer: ApnsAnswer, ageMs: number): boolean {
  if (answer.status !== 403) return false;
  if (!/ExpiredProviderToken|InvalidProviderToken/.test(answer.text)) return false;
  return ageMs >= JWT_REFRESH_MIN_AGE_MS;
}
