import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

// Render terminates TLS on the managed database and presents a certificate that is not in the
// local trust store, so it needs SSL with verification relaxed. A Postgres running on the
// developer's own machine speaks no TLS at all and rejects the handshake outright, which made the
// production setting the only one that worked and left local runs — migrations, seeds, anything
// that exercises a destructive path safely — with nowhere to point. Keyed on the host so that
// neither environment depends on a flag being set correctly.
const isLocalHost = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString ?? '');

export const pool = new Pool({
  connectionString,
  ssl: isLocalHost ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
