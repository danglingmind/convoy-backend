/** Registry of push notification types. Text is localized on the device; the server stores none. */
export type NotificationType = 'RIDE_STARTED' | 'RIDE_ENDED';

export interface NotificationData {
  rideId: string;
  rideName: string;
}

interface TypeSpec {
  /** APNs / FCM delivery priority. */
  priority: 'high' | 'normal';
  /** Replaces an earlier notification with the same id. */
  collapseId: (d: NotificationData) => string;
  /** Where a tap goes in the apps. */
  route: 'ride' | 'summary';
  /** iOS localization key for the alert body (arg: ride name). */
  locKey: string;
}

export const NOTIFICATION_TYPES: Record<NotificationType, TypeSpec> = {
  RIDE_STARTED: {
    priority: 'high',
    collapseId: (d) => `ride-${d.rideId}`,
    route: 'ride',
    locKey: 'push.ride_started.body',
  },
  RIDE_ENDED: {
    priority: 'high',
    collapseId: (d) => `ride-${d.rideId}`,
    route: 'summary',
    locKey: 'push.ride_ended.body',
  },
};
