/** Registry of push notification types. Text is localized on the device; the server stores none. */
export type NotificationType = 'RIDE_STARTED' | 'RIDE_ENDED' | 'REGROUP_CALLED' | 'EMERGENCY';

/** `safety` is never filtered by user preferences. */
export type NotificationCategory = 'ride_updates' | 'regroup' | 'safety';

export type RegroupReason = 'FUEL' | 'FOOD' | 'SCENIC';

export interface NotificationData {
  rideId: string;
  rideName: string;
  /** Caller (REGROUP_CALLED) or rider in trouble (EMERGENCY). */
  actorName?: string;
  /** Caller's user id; REGROUP_CALLED collapses per caller. */
  actorId?: string;
  /** REGROUP_CALLED only. Absent (STOP etc.) means no reason: iOS push.regroup_stop.body, Android no reason key. */
  reason?: RegroupReason;
  /** Unique per event; makes the collapse id unique for non-collapsing types. */
  eventId?: string;
}

interface TypeSpec {
  /** APNs / FCM delivery priority. */
  priority: 'high' | 'normal';
  /** Replaces an earlier notification with the same id. */
  collapseId: (d: NotificationData) => string;
  /** Where a tap goes in the apps. */
  route: 'ride' | 'summary';
  /** iOS localization key for the alert body. */
  locKey: (d: NotificationData) => string;
  /** iOS loc-args. */
  locArgs: (d: NotificationData) => string[];
  category: NotificationCategory;
  /** Android notification channel the app posts to. */
  channel: 'ride_updates' | 'safety';
}

const rideArgs = (d: NotificationData) => [d.rideName];

export const NOTIFICATION_TYPES: Record<NotificationType, TypeSpec> = {
  RIDE_STARTED: {
    priority: 'high',
    collapseId: (d) => `ride-${d.rideId}`,
    route: 'ride',
    locKey: () => 'push.ride_started.body',
    locArgs: rideArgs,
    category: 'ride_updates',
    channel: 'ride_updates',
  },
  RIDE_ENDED: {
    priority: 'high',
    collapseId: (d) => `ride-${d.rideId}`,
    route: 'summary',
    locKey: () => 'push.ride_ended.body',
    locArgs: rideArgs,
    category: 'ride_updates',
    channel: 'ride_updates',
  },
  REGROUP_CALLED: {
    priority: 'high',
    collapseId: (d) => `regroup-${d.rideId}-${d.actorId ?? d.eventId ?? ''}`,
    route: 'ride',
    locKey: (d) => d.reason ? `push.regroup_${d.reason.toLowerCase()}.body` : 'push.regroup_stop.body',
    locArgs: (d) => [d.actorName ?? '', d.rideName],
    category: 'regroup',
    channel: 'ride_updates',
  },
  EMERGENCY: {
    priority: 'high',
    collapseId: (d) => `emergency-${d.eventId ?? d.rideId}`,
    route: 'ride',
    locKey: () => 'push.emergency.body',
    locArgs: (d) => [d.actorName ?? '', d.rideName],
    category: 'safety',
    channel: 'safety',
  },
};
