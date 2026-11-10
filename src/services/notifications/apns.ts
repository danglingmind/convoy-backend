import http2 from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import { NOTIFICATION_TYPES, NotificationData, NotificationType } from './types';

const KEY_ID = process.env.APNS_KEY_ID ?? '';
const TEAM_ID = process.env.APNS_TEAM_ID ?? '';
const KEY_P8 = (process.env.APNS_KEY_P8 ?? '').replace(/\\n/g, '\n');
const BUNDLE_ID = process.env.APNS_BUNDLE_ID ?? 'danglingmind.convotrack';
if (!process.env.APNS_ENV) {
  console.warn('[apns] APNS_ENV not set: using sandbox. Production builds need APNS_ENV=production.');
}
const HOST = process.env.APNS_ENV === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

export const apnsEnabled = KEY_ID !== '' && TEAM_ID !== '' && KEY_P8 !== '';

let jwt: { value: string; at: number } | null = null;
let session: http2.ClientHttp2Session | null = null;

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

function getSession(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const s = http2.connect(HOST);
  s.on('error', () => { if (session === s) session = null; });
  s.on('close', () => { if (session === s) session = null; });
  s.unref();
  session = s;
  return s;
}

/** Send one alert. Returns false when the token is dead and should be removed. */
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

  return new Promise<boolean>((resolve, reject) => {
    const req = getSession().request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${auth}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': spec.priority === 'high' ? '10' : '5',
      'apns-collapse-id': spec.collapseId(data),
      'content-type': 'application/json',
    });
    let status = 0;
    let text = '';
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (c) => { text += c; });
    req.on('error', reject);
    req.on('close', () => {
      if (status === 200) return resolve(true);
      if (status === 410 || text.includes('Unregistered')) return resolve(false);
      if (text.includes('BadDeviceToken')) console.warn(`[apns] BadDeviceToken (status ${status}); check APNS_ENV matches the build`);
      if (status === 403) jwt = null; // provider token rejected: mint a fresh one next time
      reject(new Error(`APNs answered ${status} ${text}`));
    });
    req.end(body);
  });
}
