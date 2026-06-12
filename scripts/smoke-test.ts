/**
 * Smoke test — runs against a live deployment.
 *
 * Usage:
 *   BASE_URL=https://your-service.onrender.com TOKEN=<clerk_jwt> npm run smoke
 *   or locally:
 *   BASE_URL=http://localhost:3000 TOKEN=<clerk_jwt> npm run smoke
 */

import 'dotenv/config';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('ERROR: TOKEN env var is required (Clerk JWT)');
  process.exit(1);
}

// ── helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, detail?: string) {
  console.log(`  ✓  ${label}${detail ? `  →  ${detail}` : ''}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.log(`  ✗  ${label}${detail ? `  →  ${detail}` : ''}`);
  failed++;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  auth = true
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function assert(
  label: string,
  condition: boolean,
  detail?: string
): asserts condition {
  if (condition) ok(label, detail);
  else fail(label, detail);
}

// ── tests ──────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nSmoke test → ${BASE}\n`);

  // 1. Health
  console.log('── Health');
  const health = await req('GET', '/health', undefined, false);
  assert('GET /health returns 200', health.status === 200);
  assert(
    'Response is { ok: true }',
    (health.body as Record<string, unknown>)?.ok === true
  );

  // 2. Create ride
  console.log('\n── Create ride');
  const create = await req('POST', '/rides', {
    title: 'Smoke Test Ride',
    destinationName: 'Test Destination',
    destinationLat: 36.1627,
    destinationLng: -86.7816,
    routePolyline: 'abcdEfghij',
    distanceMeters: 10000,
    estimatedDurationSeconds: 1800,
    maxAllowedParticipants: 5,
    waypoints: [
      {
        order: 1,
        name: 'Test Destination',
        lat: 36.1627,
        lng: -86.7816,
        type: 'DESTINATION',
      },
    ],
  });

  if (create.status === 403) {
    fail(
      'POST /rides',
      `QUOTA_EXCEEDED — insert a user_memberships row for this user in Supabase`
    );
    summarise();
    return;
  }

  assert('POST /rides returns 200', create.status === 200, `status=${create.status}`);
  const { rideId, inviteCode } = create.body as Record<string, string>;
  assert('Response has rideId', !!rideId, rideId);
  assert('Response has inviteCode (6 chars)', inviteCode?.length === 6, inviteCode);

  if (!rideId) { summarise(); return; }

  // 3. Join by invite code
  console.log('\n── Invite code lookup');
  const join = await req('GET', `/rides/join/${inviteCode}`);
  assert('GET /rides/join/:code returns 200', join.status === 200, `status=${join.status}`);
  const joinBody = join.body as Record<string, unknown>;
  assert('status is LOBBY', joinBody?.status === 'LOBBY');
  assert('participantCount is 1 (leader)', joinBody?.participantCount === 1);

  // 4. Get full ride
  console.log('\n── Get ride');
  const get = await req('GET', `/rides/${rideId}`);
  assert('GET /rides/:id returns 200', get.status === 200);
  const getRide = get.body as Record<string, unknown>;
  assert('Ride has 1 waypoint', (getRide?.waypoints as unknown[])?.length === 1);
  assert('Ride has 1 participant', (getRide?.participants as unknown[])?.length === 1);
  assert('routePolyline absent', !('routePolyline' in (getRide ?? {})));

  // 5. Missing DESTINATION waypoint rejected
  console.log('\n── Validation');
  const bad = await req('POST', '/rides', {
    title: 'Bad Ride',
    destinationName: 'X',
    destinationLat: 0,
    destinationLng: 0,
    routePolyline: 'x',
    distanceMeters: 1,
    estimatedDurationSeconds: 1,
    maxAllowedParticipants: 2,
    waypoints: [{ order: 1, name: 'Stop', lat: 0, lng: 0, type: 'STOP' }],
  });
  assert('Missing DESTINATION returns 400', bad.status === 400);
  assert(
    'Error is INVALID_WAYPOINTS',
    (bad.body as Record<string, unknown>)?.error === 'INVALID_WAYPOINTS'
  );

  // 6. Start ride
  console.log('\n── Start / end lifecycle');
  const start = await req('POST', `/rides/${rideId}/start`);
  assert('POST /rides/:id/start returns 200', start.status === 200);

  // 7. Can't start again
  const startAgain = await req('POST', `/rides/${rideId}/start`);
  assert('Second start returns 409', startAgain.status === 409);

  // 8. Pause
  const pause = await req('POST', `/rides/${rideId}/pause`);
  assert('POST /rides/:id/pause returns 200', pause.status === 200);

  // 9. Resume
  const resume = await req('POST', `/rides/${rideId}/resume`);
  assert('POST /rides/:id/resume returns 200', resume.status === 200);

  // 10. End
  const end = await req('POST', `/rides/${rideId}/end`);
  assert('POST /rides/:id/end returns 200', end.status === 200);
  assert('Response has rideId', (end.body as Record<string, unknown>)?.rideId === rideId);

  // 11. Summary
  console.log('\n── Summary');
  const summary = await req('GET', `/rides/${rideId}/summary`);
  assert('GET /rides/:id/summary returns 200', summary.status === 200);
  const s = summary.body as Record<string, unknown>;
  assert('Summary has durationSeconds', typeof s?.durationSeconds === 'number');
  assert('compactnessScore is 0–100', (s?.compactnessScore as number) >= 0);
  const participants = s?.participants as Record<string, unknown>[];
  assert(
    'Leader has RIDE_LEADER title',
    participants?.[0]?.rideTitle === 'RIDE_LEADER'
  );
  assert('Leader syncScore is 100', participants?.[0]?.syncScore === 100);

  // 12. Summary blocked on non-completed ride
  console.log('\n── Guard checks');
  const lobbyRide = await req('POST', '/rides', {
    title: 'Guard Test',
    destinationName: 'X',
    destinationLat: 0,
    destinationLng: 0,
    routePolyline: 'x',
    distanceMeters: 1,
    estimatedDurationSeconds: 1,
    maxAllowedParticipants: 2,
    waypoints: [{ order: 1, name: 'X', lat: 0, lng: 0, type: 'DESTINATION' }],
  });
  if (lobbyRide.status === 200) {
    const lobbyId = (lobbyRide.body as Record<string, string>).rideId;
    const earlySum = await req('GET', `/rides/${lobbyId}/summary`);
    assert('Summary on LOBBY ride returns 409', earlySum.status === 409);
  }

  summarise();
}

function summarise() {
  const total = passed + failed;
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : '  ✓'}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
