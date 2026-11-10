import { SignJWT, importPKCS8 } from 'jose';
import { NOTIFICATION_TYPES, NotificationData, NotificationType } from './types';

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

function parseAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as ServiceAccount;
    return a.project_id && a.client_email && a.private_key ? a : null;
  } catch {
    return null;
  }
}

const account = parseAccount();
export const fcmEnabled = account !== null;

let access: { value: string; expires: number } | null = null;

async function accessToken(a: ServiceAccount): Promise<string> {
  if (access && Date.now() < access.expires - 60_000) return access.value;
  const key = await importPKCS8(a.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(a.client_email)
    .setSubject(a.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google OAuth answered ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  access = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return access.value;
}

/** Send one data-only message. Returns false when the token is dead and should be removed. */
export async function sendFcm(
  token: string,
  type: NotificationType,
  data: NotificationData
): Promise<boolean> {
  if (!account) return true;
  const spec = NOTIFICATION_TYPES[type];
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken(account)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        data: { type, rideId: data.rideId, rideName: data.rideName },
        android: { priority: spec.priority === 'high' ? 'HIGH' : 'NORMAL', collapse_key: spec.collapseId(data) },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return true;
  const text = await res.text();
  let code = '';
  try {
    const e = JSON.parse(text)?.error;
    code = e?.status ?? '';
    for (const d of e?.details ?? []) if (d?.errorCode) code = d.errorCode === 'UNREGISTERED' ? 'UNREGISTERED' : code;
  } catch { /* non-JSON body */ }
  if (code === 'UNREGISTERED') return false;
  if (res.status === 401) access = null;
  throw new Error(`FCM answered ${res.status} ${text.slice(0, 200)}`);
}
