import { SignJWT, importPKCS8 } from 'jose';

/**
 * Google Play subscription verification.
 *
 * Play does not hand the client a self-verifying artefact the way StoreKit 2
 * does — `purchaseToken` is an opaque string that means nothing until Google is
 * asked about it. So unlike the Apple path, which verifies a signature offline,
 * every activation here costs a round trip to the Play Developer API.
 *
 * Authentication is the OAuth2 service-account flow, implemented directly on top
 * of `jose` (already a dependency for Apple JWS verification) rather than
 * pulling in `googleapis`, which is a ~50MB dependency for the sake of one GET.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export class PlayNotConfiguredError extends Error {
  constructor() {
    super('Google Play verification is not configured');
    this.name = 'PlayNotConfiguredError';
  }
}

/** Thrown when Google answers, but the answer is "this purchase is not valid". */
export class PlayPurchaseInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayPurchaseInvalidError';
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new PlayNotConfiguredError();
  let parsed: Partial<ServiceAccount>;
  try {
    // Accept both raw JSON and base64, since a PEM's newlines survive base64
    // intact but are routinely mangled when pasted into a dashboard env field.
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    throw new PlayNotConfiguredError();
  }
  if (!parsed.client_email || !parsed.private_key) throw new PlayNotConfiguredError();
  return {
    client_email: parsed.client_email,
    // Survives the same mangling: a key pasted with literal \n sequences.
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  };
}

export function isPlayConfigured(): boolean {
  try {
    serviceAccount();
    return Boolean(packageName());
  } catch {
    return false;
  }
}

function packageName(): string {
  return process.env.ANDROID_PACKAGE_NAME || 'com.danglingmind.convotrack';
}

// Access tokens are valid for an hour. Cached with a 60s safety margin so a
// token cannot expire in flight between the check and the API call.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const sa  = serviceAccount();
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Play OAuth token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const body = await res.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('Play OAuth token exchange returned no access_token');

  cachedToken = {
    value:     body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/** The subset of `subscriptionsv2` we act on. */
interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  testPurchase?: object;
  linkedPurchaseToken?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;   // RFC3339
  }>;
  startTime?: string;      // RFC3339
}

export interface PlayPurchase {
  productId:   string;
  expiresAt:   Date;
  startsAt:    Date;
  environment: 'Sandbox' | 'Production';
  /** Set when Play has superseded this token by an upgrade/downgrade. */
  linkedPurchaseToken?: string;
}

// States that represent a subscription the rider should actually be getting
// something for. IN_GRACE_PERIOD is included deliberately: payment has failed
// but Google is still retrying, and taking the plan away mid-retry would punish
// a rider for an expired card that may well go through.
const ENTITLED_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  // Cancelled but not yet expired — paid through the end of the period.
  'SUBSCRIPTION_STATE_CANCELED',
]);

/**
 * Ask Google what a purchase token actually is.
 *
 * Throws `PlayPurchaseInvalidError` when Google says the purchase is unusable
 * (unknown token, expired, revoked), and a plain `Error` when the lookup itself
 * failed — the caller maps the first to a 400 and the second to a 502, because
 * only one of them is the rider's problem.
 */
export async function verifyPlayPurchase(purchaseToken: string): Promise<PlayPurchase> {
  const token = await accessToken();
  const url =
    `${ANDROID_PUBLISHER}/applications/${encodeURIComponent(packageName())}` +
    `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 400 || res.status === 404 || res.status === 410) {
    throw new PlayPurchaseInvalidError('PURCHASE_NOT_FOUND');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Play purchase lookup failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const body = await res.json() as SubscriptionPurchaseV2;

  const state = body.subscriptionState ?? '';
  if (!ENTITLED_STATES.has(state)) {
    throw new PlayPurchaseInvalidError('PURCHASE_NOT_ACTIVE');
  }

  // A multi-line subscription is possible in principle; in practice ConvoTrack
  // sells one plan per purchase, so the first line item with an expiry is it.
  const line = body.lineItems?.find((l) => l.expiryTime && l.productId);
  if (!line?.productId || !line.expiryTime) {
    throw new PlayPurchaseInvalidError('PURCHASE_NOT_ACTIVE');
  }

  const expiresAt = new Date(line.expiryTime);
  const startsAt  = body.startTime ? new Date(body.startTime) : new Date();
  if (Number.isNaN(expiresAt.getTime())) {
    throw new PlayPurchaseInvalidError('PURCHASE_NOT_ACTIVE');
  }

  return {
    productId:   line.productId,
    expiresAt,
    startsAt:    Number.isNaN(startsAt.getTime()) ? new Date() : startsAt,
    // `testPurchase` is Play's licence-tester marker — the analogue of Apple's
    // Sandbox environment, and gated the same way in production.
    environment: body.testPurchase ? 'Sandbox' : 'Production',
    linkedPurchaseToken: body.linkedPurchaseToken,
  };
}

/**
 * Acknowledge a purchase. Play auto-refunds anything left unacknowledged for
 * three days, and doing it server-side after verification means the entitlement
 * and the acknowledgement cannot disagree.
 *
 * Best-effort: a purchase that is already acknowledged answers 400, which is not
 * a failure worth failing the activation over.
 */
export async function acknowledgePlayPurchase(
  purchaseToken: string,
  productId: string
): Promise<void> {
  const token = await accessToken();
  const url =
    `${ANDROID_PUBLISHER}/applications/${encodeURIComponent(packageName())}` +
    `/purchases/subscriptions/${encodeURIComponent(productId)}` +
    `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    '{}',
  });
}
