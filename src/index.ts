import 'dotenv/config';
import { buildApp } from './app';
import { initSocketServer } from './sockets/server';
import { flushAnalytics } from './services/analytics';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Server listening on port ${PORT}`);

  initSocketServer(app.server);
  app.log.info('Socket.IO initialized');

  // Render sends SIGTERM on every deploy; push the queued analytics events out before exiting.
  process.once('SIGTERM', () => {
    void flushAnalytics().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
