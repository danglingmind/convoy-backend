/**
 * Product analytics (PostHog), server side. Fire-and-forget: a dead analytics host must never slow
 * or fail a ride, so nothing here throws and nothing awaits the network on a request path.
 *
 * Ride lifecycle, safety and revenue events are captured here rather than on the phones because
 * the server is the only place that knows they actually happened (a client "ride started" can
 * fire for a request that then fails; an offline rider's never arrives). The apps send the
 * interface-level events (screens, onboarding, sharing, permissions) from their own `Analytics`.
 *
 * Privacy: events carry the Clerk user id and counts / enums only. Never coordinates, place names,
 * invite codes, names, emails or phone numbers. The full taxonomy is `docs/analytics.md` in the
 * iOS repo.
 *
 * Off unless `POSTHOG_API_KEY` is set, so local dev and tests send nothing.
 */

const API_KEY = process.env.POSTHOG_API_KEY ?? '';
const HOST = (process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com').replace(/\/+$/, '');

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH = 100;
// A long outage can't grow the queue without bound; the oldest events are the ones dropped.
const MAX_QUEUE = 1_000;

type Props = Record<string, string | number | boolean | null | undefined>;

interface QueuedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

const queue: QueuedEvent[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

export const analyticsEnabled = API_KEY.length > 0;

/** Record one event for a rider. `props` must already be free of personal data. */
export function capture(
  distinctId: string,
  event: string,
  props: Props = {},
  opts: { at?: Date; set?: Props } = {}
): void {
  if (!analyticsEnabled) return;
  // $geoip_disable: the request comes from our server, so PostHog's IP lookup would stamp the
  // data centre's location onto the rider (and onto their person profile). The apps' own events
  // carry the device's IP and set the real location.
  const properties: Record<string, unknown> = {
    ...props,
    source: 'server',
    $lib: 'convoy-backend',
    $geoip_disable: true,
  };
  if (opts.set) properties.$set = opts.set;
  queue.push({
    event,
    distinct_id: distinctId,
    properties,
    timestamp: (opts.at ?? new Date()).toISOString(),
  });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (queue.length >= MAX_BATCH) void flushAnalytics();
  else schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushAnalytics();
  }, FLUSH_INTERVAL_MS);
  timer.unref();
}

/** Send what is queued. Safe to call anytime; also run on shutdown so a deploy doesn't lose the tail. */
export async function flushAnalytics(): Promise<void> {
  if (!analyticsEnabled) return;
  if (flushing) return flushing;
  flushing = (async () => {
    while (queue.length > 0) {
      const batch = queue.splice(0, MAX_BATCH);
      try {
        const res = await fetch(`${HOST}/batch/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: API_KEY, batch }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`PostHog answered ${res.status}`);
      } catch (err) {
        // Put it back for the next tick (bounded) and stop; don't spin against a dead host.
        queue.unshift(...batch);
        if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
        console.warn('[analytics] flush failed:', (err as Error).message);
        schedule();
        return;
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Rounded kilometres for event properties (a count-like figure, not a trace of the route). */
export const km = (meters: number | null | undefined): number | undefined =>
  typeof meters === 'number' && Number.isFinite(meters) ? Math.round(meters / 100) / 10 : undefined;
