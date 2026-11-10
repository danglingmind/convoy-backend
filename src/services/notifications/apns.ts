import { createHash } from 'node:crypto';
import http2 from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import { ApnsAnswer, ApnsEnv, deliver, hostOrder, shouldRefreshJwt } from './apnsRouting';
import { NOTIFICATION_TYPES, NotificationData, NotificationType } from './types';

const KEY_ID = process.env.APNS_KEY_ID ?? '';
const TEAM_ID = process.env.APNS_TEAM_ID ?? '';
const KEY_P8 = (process.env.APNS_KEY_P8 ?? '').replace(/\\n/g, '\n');
const BUNDLE_ID = process.env.APNS_BUNDLE_ID ?? 'danglingmind.convotrack';
const APNS_ENV = process.env.APNS_ENV;
const HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export const apnsEnabled = KEY_ID !== '' && TEAM_ID !== '' && KEY_P8 !== '';

let jwt: { value: string; at: number } | null = null;
const sessions: Partial<Record<ApnsEnv, http2.ClientHttp2Session>> = {};
/** Which host last answered for a token, so dev devices skip the production miss. Bounded. */
const knownEnv = new Map<string, ApnsEnv>();

/** APNs wants the provider token refreshed between 20 and 60 minutes; reuse for 40. */
async function providerToken(): Promise<string> {
  if (jwt && Date.now() - jwt.at < 40 * 60_000) return jwt.value;
  const key = await importPKCS8(KEY_P8, 'ES256');
  const value = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
    .setIssuer(TEAM_ID)
    .setIssuedAt()
    .sign(key);
  jwt = { value, at: Date.now() };
  return value;
}

function getSession(env: ApnsEnv): http2.ClientHttp2Session {
  const existing = sessions[env];
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const s = http2.connect(HOSTS[env]);
  s.on('error', () => { if (sessions[env] === s) delete sessions[env]; });
  s.on('close', () => { if (sessions[env] === s) delete sessions[env]; });
  s.unref();
  sessions[env] = s;
  return s;
}

/** APNs rejects an `apns-collapse-id` over 64 bytes (BadCollapseId): hash the long ones. */
export function apnsCollapseId(raw: string): string {
  if (Buffer.byteLength(raw) <= 64) return raw;
  return `c-${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

function request(
  env: ApnsEnv,
  token: string,
  auth: string,
  priority: string,
  collapseId: string,
  body: string
): Promise<ApnsAnswer> {
  return new Promise<ApnsAnswer>((resolve, reject) => {
    const req = getSession(env).request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${auth}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': priority,
      'apns-collapse-id': collapseId,
      'content-type': 'application/json',
    });
    let status = 0;
    let text = '';
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (c) => { text += c; });
    req.on('error', reject);
    req.on('close', () => resolve({ status, text }));
    req.end(body);
  });
}

/**
 * Send one alert. Returns false when the token is dead and should be removed; throws on any other
 * failure. The token is tried on the production host first and on sandbox when production says
 * BadDeviceToken (a dev build), so one deployment serves both kinds of build.
 */
export async function sendApns(
  token: string,
  type: NotificationType,
  data: NotificationData
): Promise<boolean> {
  const spec = NOTIFICATION_TYPES[type];
  const auth = await providerToken();
  const body = JSON.stringify({
    aps: {
      alert: { 'loc-key': spec.locKey(data), 'loc-args': spec.locArgs(data) },
      sound: 'default',
      'thread-id': `ride-${data.rideId}`,
    },
    type,
    rideId: data.rideId,
  });
  const priority = spec.priority === 'high' ? '10' : '5';
  const collapseId = apnsCollapseId(spec.collapseId(data));

  const result = await deliver(hostOrder(APNS_ENV, knownEnv.get(token)), (env) =>
    request(env, token, auth, priority, collapseId, body)
  );

  if (result.env) {
    if (knownEnv.size >= 5000) knownEnv.clear();
    knownEnv.set(token, result.env);
  }
  if (result.outcome === 'sent') return true;
  if (result.outcome === 'dead') return false;
  if (jwt && shouldRefreshJwt(result.answer, Date.now() - jwt.at)) jwt = null;
  throw new Error(`APNs answered ${result.answer.status} ${result.answer.text}`);
}
