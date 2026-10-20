/**
 * Add demo riders (pre-marked READY) to an EXISTING ride.
 *
 * Use this when you create the ride yourself from the app — so the route,
 * waypoints, and camera all load correctly relative to your real location —
 * and just want the group populated so the leader's "Start Ride" gate opens.
 *
 * It does NOT create rides or waypoints. It only inserts the four scripted
 * demo riders as READY participants of the ride you point it at.
 *
 * Usage:
 *   npm run seed:riders -- <INVITE_CODE>
 *   INVITE_CODE=RYDE23 npm run seed:riders
 *
 * Re-running is safe (idempotent upsert). Pass --remove to pull the demo
 * riders back out of the ride:
 *   npm run seed:riders -- <INVITE_CODE> --remove
 */

import 'dotenv/config';
import { pool } from '../src/db/pool';

interface DemoUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

const DEMO_RIDERS: DemoUser[] = [
  { id: 'demo_rider_leader', name: 'Marcus Chen', avatarUrl: null },
  { id: 'demo_rider_02', name: 'Sofia Reyes', avatarUrl: null },
  { id: 'demo_rider_03', name: 'Jamal Woods', avatarUrl: null },
  { id: 'demo_rider_04', name: 'Priya Nair', avatarUrl: null },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const remove = args.includes('--remove');
  const inviteCode = (args.find((a) => !a.startsWith('--')) || process.env.INVITE_CODE || '')
    .trim()
    .toUpperCase();

  if (!inviteCode) {
    console.error('Usage: npm run seed:riders -- <INVITE_CODE> [--remove]');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const { rows: rideRows } = await client.query(
      `SELECT id, title, status, leader_id, max_allowed_participants
       FROM rides WHERE invite_code = $1`,
      [inviteCode]
    );
    const ride = rideRows[0];
    if (!ride) {
      console.error(`No ride found for invite code "${inviteCode}".`);
      process.exit(1);
    }

    await client.query('BEGIN');

    if (remove) {
      await client.query(
        `DELETE FROM ride_participants
         WHERE ride_id = $1 AND user_id = ANY($2)`,
        [ride.id, DEMO_RIDERS.map((r) => r.id)]
      );
    } else {
      for (const u of DEMO_RIDERS) {
        // Ensure the demo user row exists (FK target), then join as READY.
        await client.query(
          `INSERT INTO users (id, name, avatar_url) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
          [u.id, u.name, u.avatarUrl]
        );
        await client.query(
          `INSERT INTO ride_participants (ride_id, user_id, status)
           VALUES ($1, $2, 'READY')
           ON CONFLICT (ride_id, user_id) DO UPDATE SET status = 'READY'`,
          [ride.id, u.id]
        );
      }
    }

    await client.query('COMMIT');

    const { rows: roster } = await client.query(
      `SELECT u.name, rp.status, (rp.user_id = $2) AS is_leader
       FROM ride_participants rp JOIN users u ON u.id = rp.user_id
       WHERE rp.ride_id = $1 AND rp.status != 'LEFT'
       ORDER BY (rp.user_id = $2) DESC, rp.joined_at`,
      [ride.id, ride.leader_id]
    );

    console.log(`\n${remove ? '✓ Removed demo riders from' : '✓ Added demo riders to'} "${ride.title}" [${ride.status}]  (code: ${inviteCode})`);
    if (ride.status !== 'LOBBY') {
      console.log(`  ⚠ Ride is ${ride.status}, not LOBBY — riders only help while it's in the lobby.`);
    }
    console.log('  Roster:');
    for (const r of roster) {
      console.log(`    - ${r.name}${r.is_leader ? ' (leader)' : ''}  →  ${r.status}`);
    }
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('seed-riders failed:', err.message ?? err);
    await pool.end();
    process.exit(1);
  });
