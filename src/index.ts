import 'dotenv/config';
import { buildApp } from './app';
import { initSocketServer } from './sockets/server';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Server listening on port ${PORT}`);

  initSocketServer(app.server);
  app.log.info('Socket.IO initialized');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
