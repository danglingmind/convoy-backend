import 'dotenv/config';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { buildApp } from '../src/app';

async function main() {
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'silent';

  const fastify = await buildApp();
  await fastify.ready();

  const spec = fastify.swagger();
  const outPath = resolve(__dirname, '../openapi.json');
  writeFileSync(outPath, JSON.stringify(spec, null, 2));
  console.log(`OpenAPI spec written to ${outPath}`);

  await fastify.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
