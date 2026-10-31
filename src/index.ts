import 'dotenv/config';
import { buildApp } from './app';
import { initSocketServer } from './sockets/server';
import { flushAnalytics } from './services/analytics';
import { rideStore } from './store/rideStore';
import { flushTrackBuffer } from './services/trackService';
import { deleteTrackPointsOlderThan } from './db/trackRepo';

// Raw leader track points are only needed briefly; the simplified route stays on the ride.
const TRACK_RETENTION_DAYS = 90;

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Server listening on port ${PORT}`);

  initSocketServer(app.server);
  app.log.info('Socket.IO initialized');

  // Render sends SIGTERM on every deploy; push the queued analytics events out before exiting.
  // Also write out buffered leader track points so a deploy mid-ride doesn't drop the last 30 s.
  process.once('SIGTERM', () => {
    void Promise.allSettled([
      flushAnalytics(),
      ...rideStore.all().map((state) => flushTrackBuffer(state)),
    ]).finally(() => process.exit(0));
  });

  const purgeTrackPoints = () => {
    deleteTrackPointsOlderThan(TRACK_RETENTION_DAYS).catch((err) =>
      app.log.warn({ err }, 'track point retention purge failed'));
  };
  purgeTrackPoints();
  setInterval(purgeTrackPoints, 24 * 60 * 60 * 1000).unref();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
