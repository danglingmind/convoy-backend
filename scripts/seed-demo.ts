/**
 * App Review demo seed.
 *
 * Creates a stable, reviewer-facing demo dataset so an Apple/Google reviewer
 * signing in with a fresh account can experience the group-ride feature:
 *
 *   1. A LOBBY ride "Demo Group Ride" (invite code DEMO_INVITE_CODE below) led by a
 *      demo rider and pre-joined by 3 more demo riders. The reviewer taps
 *      "Join Ride", enters the code, and sees a populated group lobby.
 *   2. A COMPLETED ride "Coast Loop" with a full ride summary + per-rider
 *      titles/scores, so the recap/summary screen is populated.
 *
 * All data lives in Postgres (survives Render spin-down / restarts, unlike the
 * in-memory rideStore). Re-running is safe — it deletes and rebuilds the two
 * fixed demo rides each time.
 *
 * Required: set DEMO_MEMBER_CLERK_ID to a real Clerk user id (e.g. your own
 * test account, taken from the Clerk dashboard) to pre-join that account to
 * BOTH rides — the COMPLETED ride then also appears in that account's in-app
 * ride history.
 *
 * Usage:
 *   DATABASE_URL=postgres://... DEMO_MEMBER_CLERK_ID=user_xxx npm run seed:demo
 */

import 'dotenv/config';
import { pool } from '../src/db/pool';

// Fixed invite code — safe charset only (no ambiguous 0/O/1/I/L), so it's
// unmistakable when a reviewer types it by hand.
const DEMO_INVITE_CODE = 'RYDE23';

// Fixed ride ids so re-running is idempotent.
const LOBBY_RIDE_ID = '11111111-1111-4111-8111-111111111111';
const DONE_RIDE_ID = '22222222-2222-4222-8222-222222222222';

// Google-encoded sample polyline (only decoded on ride start, which the seed
// never triggers — a valid non-empty string is all that's required here).
const SAMPLE_POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

const FREE_SNAPSHOT = { monthlyLimit: 10, maxRidersPerRide: 5 };

// The App Review demo account is pre-joined to both demo rides so the reviewer sees them
// immediately after sign-in. Its Clerk user id comes from DEMO_MEMBER_CLERK_ID (set it in .env)
// and is deliberately not committed: this repository is public.

interface DemoUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

const LEADER: DemoUser = { id: 'demo_rider_leader', name: 'Marcus Chen', avatarUrl: null };
const MEMBERS: DemoUser[] = [
  { id: 'demo_rider_02', name: 'Sofia Reyes', avatarUrl: null },
  { id: 'demo_rider_03', name: 'Jamal Woods', avatarUrl: null },
  { id: 'demo_rider_04', name: 'Priya Nair', avatarUrl: null },
];
const ALL_DEMO_USERS = [LEADER, ...MEMBERS];

async function upsertUser(client: import('pg').PoolClient, u: DemoUser): Promise<void> {
  await client.query(
    `INSERT INTO users (id, name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url`,
    [u.id, u.name, u.avatarUrl]
  );
}

/** Delete all child rows + the ride itself for a fixed demo ride id. */
async function purgeRide(client: import('pg').PoolClient, rideId: string): Promise<void> {
  // ride_summaries has no ON DELETE CASCADE, so remove children explicitly.
  await client.query('DELETE FROM ride_summaries WHERE ride_id = $1', [rideId]);
  await client.query('DELETE FROM emergency_events WHERE ride_id = $1', [rideId]);
  await client.query('DELETE FROM regroup_events WHERE ride_id = $1', [rideId]);
  await client.query('DELETE FROM ride_participants WHERE ride_id = $1', [rideId]);
  await client.query('DELETE FROM ride_waypoints WHERE ride_id = $1', [rideId]);
  await client.query('DELETE FROM rides WHERE id = $1', [rideId]);
}

async function addParticipant(
  client: import('pg').PoolClient,
  rideId: string,
  userId: string,
  opts: { rideTitle?: string; syncScore?: number; status?: string } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO ride_participants (ride_id, user_id, status, ride_title, sync_score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ride_id, user_id) DO UPDATE
       SET status = EXCLUDED.status, ride_title = EXCLUDED.ride_title, sync_score = EXCLUDED.sync_score`,
    [rideId, userId, opts.status ?? 'JOINED', opts.rideTitle ?? null, opts.syncScore ?? null]
  );
}

async function seed(): Promise<void> {
  const reviewerId = process.env.DEMO_MEMBER_CLERK_ID?.trim();
  if (!reviewerId) {
    throw new Error('DEMO_MEMBER_CLERK_ID is not set: put the App Review demo account\'s Clerk user id in .env');
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Demo users. The reviewer's row normally already exists (created on
    // first sign-in); create a placeholder if seeding before they sign in, so
    // it can be referenced as the lobby leader.
    for (const u of ALL_DEMO_USERS) await upsertUser(client, u);
    const { rows: reviewerRows } = await client.query('SELECT 1 FROM users WHERE id = $1', [reviewerId]);
    if (reviewerRows.length === 0) {
      await upsertUser(client, { id: reviewerId, name: 'Demo Reviewer', avatarUrl: null });
    }

    // 2. Reset both demo rides
    await purgeRide(client, LOBBY_RIDE_ID);
    await purgeRide(client, DONE_RIDE_ID);

    // 3. LOBBY ride — the reviewer-joinable group lobby
    await client.query(
      `INSERT INTO rides
         (id, title, status, leader_id, invite_code, destination_name,
          destination_lat, destination_lng, route_polyline, distance_meters,
          estimated_duration_seconds, max_allowed_participants, membership_snapshot)
       VALUES ($1,'Demo Group Ride','LOBBY',$2,$3,'Golden Gate Bridge',
          37.8199,-122.4783,$4,8200,1200,10,$5)`,
      [LOBBY_RIDE_ID, reviewerId, DEMO_INVITE_CODE, SAMPLE_POLYLINE, JSON.stringify(FREE_SNAPSHOT)]
    );
    await client.query(
      `INSERT INTO ride_waypoints (ride_id, "order", name, lat, lng, type) VALUES
         ($1, 1, 'Golden Gate Park', 37.7694, -122.4862, 'START'),
         ($1, 2, 'Golden Gate Bridge', 37.8199, -122.4783, 'DESTINATION')`,
      [LOBBY_RIDE_ID]
    );
    // Demo account is the leader (so the reviewer can start the ride). The four
    // scripted riders join pre-marked READY, so the leader's "Start Ride" gate
    // (all non-leaders READY) is satisfied immediately — they have no device to
    // emit a ready event themselves.
    await addParticipant(client, LOBBY_RIDE_ID, reviewerId);
    for (const u of ALL_DEMO_USERS) await addParticipant(client, LOBBY_RIDE_ID, u.id, { status: 'READY' });

    // 4. COMPLETED ride — populates the recap / summary screen
    const startedAt = new Date(Date.now() - 90 * 60 * 1000); // 90 min ago
    const endedAt = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
    await client.query(
      `INSERT INTO rides
         (id, title, status, leader_id, invite_code, destination_name,
          destination_lat, destination_lng, route_polyline, distance_meters,
          estimated_duration_seconds, max_allowed_participants, membership_snapshot,
          started_at, ended_at)
       VALUES ($1,'Coast Loop','COMPLETED',$2,'CST294','Half Moon Bay',
          37.4636,-122.4286,$3,42600,3600,10,$4,$5,$6)`,
      [DONE_RIDE_ID, LEADER.id, SAMPLE_POLYLINE, JSON.stringify(FREE_SNAPSHOT), startedAt, endedAt]
    );
    await client.query(
      `INSERT INTO ride_waypoints (ride_id, "order", name, lat, lng, type) VALUES
         ($1, 1, 'Pacifica', 37.6138, -122.4869, 'START'),
         ($1, 2, 'Half Moon Bay', 37.4636, -122.4286, 'DESTINATION')`,
      [DONE_RIDE_ID]
    );
    // Per-rider titles use the backend enum strings; iOS maps them to display text.
    await addParticipant(client, DONE_RIDE_ID, LEADER.id, { rideTitle: 'RIDE_LEADER', syncScore: 100 });
    const doneTitles: { rideTitle: string; syncScore: number }[] = [
      { rideTitle: 'PACE_KEEPER', syncScore: 94 },
      { rideTitle: 'TRAIL_GUARDIAN', syncScore: 88 },
      { rideTitle: 'FORMATION_RIDER', syncScore: 91 },
    ];
    for (let i = 0; i < MEMBERS.length; i++) {
      await addParticipant(client, DONE_RIDE_ID, MEMBERS[i].id, doneTitles[i]);
    }
    await client.query(
      `INSERT INTO ride_summaries
         (ride_id, duration_seconds, distance_meters, avg_speed_kmh,
          max_group_split_meters, compactness_score, total_regroups, total_emergencies)
       VALUES ($1, 2700, 42600, 56.8, 320, 0.87, 2, 0)`,
      [DONE_RIDE_ID]
    );

    // 5. Pre-join the reviewer to the completed ride so it shows in their
    //    history (they're already the leader/member of the lobby ride above).
    await addParticipant(client, DONE_RIDE_ID, reviewerId, { rideTitle: 'FORMATION_RIDER', syncScore: 90 });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('\n✓ Demo data seeded\n');
  console.log(`  Group lobby ride : "Demo Group Ride"  (invite code: ${DEMO_INVITE_CODE})`);
  console.log(`  Riders in lobby  : ${ALL_DEMO_USERS.map((u) => u.name).join(', ')}`);
  console.log(`  Completed ride   : "Coast Loop"  (recap + per-rider titles)`);
  console.log(`  Pre-joined account: ${process.env.DEMO_MEMBER_CLERK_ID?.trim()}`);
  console.log('');
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('seed failed:', err);
    await pool.end();
    process.exit(1);
  });
