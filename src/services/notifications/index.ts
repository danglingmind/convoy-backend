/**
 * Push notifications. `notify` is fire-and-forget: it never throws and callers must not await it
 * on a request path. Off per platform until its env vars exist (logged once), like analytics.
 * Payloads carry keys + the ride name only; the apps localize the text.
 */
import { deleteDeadToken, getDevicesForUsers } from '../../db/deviceRepo';
import { apnsEnabled, sendApns } from './apns';
import { fcmEnabled, sendFcm } from './fcm';
import { getDisabledUsers } from '../../db/notificationPrefsRepo';
import { NOTIFICATION_TYPES, NotificationData, NotificationType } from './types';

export { NOTIFICATION_TYPES } from './types';
export type { NotificationType, NotificationData } from './types';

console.log(`[notifications] apns=${apnsEnabled ? 'on' : 'off'} fcm=${fcmEnabled ? 'on' : 'off'}`);

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[notifications] ${msg}`);
}

export function notify(userIds: string[], type: NotificationType, data: NotificationData): void {
  void deliver(userIds, type, data).catch((err) => {
    console.warn('[notifications] send failed:', (err as Error).message);
  });
}

async function deliver(userIds: string[], type: NotificationType, data: NotificationData): Promise<void> {
  if (userIds.length === 0) return;
  const category = NOTIFICATION_TYPES[type].category;
  if (category !== 'safety') {
    let off = new Set<string>();
    try {
      off = await getDisabledUsers(userIds, category);
    } catch (err) {
      console.warn('[notifications] prefs lookup failed, sending anyway:', (err as Error).message);
    }
    userIds = userIds.filter((u) => !off.has(u));
    if (userIds.length === 0) return;
  }
  const devices = await getDevicesForUsers(userIds);
  console.log(
    `[notifications] ${type} ride=${data.rideId} recipients=${userIds.length} devices=${devices.length}` +
      ` (ios=${devices.filter((d) => d.platform === 'ios').length} android=${devices.filter((d) => d.platform !== 'ios').length})`
  );
  await Promise.all(devices.map(async (d) => {
    try {
      if (d.platform === 'ios') {
        if (!apnsEnabled) return warnOnce('apns', 'APNs not configured; iOS push skipped');
        const ok = await sendApns(d.token, type, data);
        console.log(`[notifications] ${type} ios ${ok ? 'sent' : 'token dead, removed'}`);
        if (!ok) await deleteDeadToken(d.token);
      } else {
        if (!fcmEnabled) return warnOnce('fcm', 'FCM not configured; Android push skipped');
        const ok = await sendFcm(d.token, type, data);
        console.log(`[notifications] ${type} android ${ok ? 'sent' : 'token dead, removed'}`);
        if (!ok) await deleteDeadToken(d.token);
      }
    } catch (err) {
      console.warn(`[notifications] ${d.platform} send failed:`, (err as Error).message);
    }
  }));
}
