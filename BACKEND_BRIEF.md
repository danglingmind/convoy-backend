# Convoy Backend — Build Brief

Self-contained spec for building the convoy backend from scratch.
No other files from the iOS repo are needed.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 |
| Framework | Fastify 4 + TypeScript (strict mode) |
| Realtime | Socket.IO 4 |
| Database | PostgreSQL (Supabase) |
| Auth | Clerk (JWT verification only — no auth endpoints) |
| Deployment | Railway (optional for now, placeholder config) |

---

## Environment Variables

```env
# Server
NODE_ENV=development
PORT=3000

# Database (Supabase — replace with real values)
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST].supabase.co:5432/postgres

# Clerk (JWT verification)
CLERK_PUBLISHABLE_KEY=pk_test_d2VsbC1raXdpLTk2LmNsZXJrLmFjY291bnRzLmRldiQ
CLERK_SECRET_KEY=sk_test_5xeIgpBA9KSp4dO5ITe9RgvLsMIZkohu3InJfSiDsb

# CORS (iOS-only now; no browser clients)
ALLOWED_ORIGINS=*

# Engine thresholds
OFF_ROUTE_THRESHOLD_METERS=75
SPLIT_THRESHOLD_METERS=5000
```

---

## Folder Structure

```
/src
  /db           — repository functions (no raw SQL anywhere else)
  /routes       — Fastify route handlers
  /sockets      — Socket.IO event handlers + broadcaster
  /engines      — progressEngine, leaderboardEngine
  /services     — quotaService, summaryService
  /store        — in-memory rideStore (ActiveRideState)
  /middleware   — auth (REST + socket)
  /types        — shared TypeScript interfaces
/migrations     — numbered sequential SQL files
```

---

## Database Schema

Run all migrations in order. Everything below is the complete schema.

```sql
-- 001_create_users.sql
CREATE TABLE users (
  id          TEXT        PRIMARY KEY,  -- Clerk user ID
  name        TEXT        NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 002_create_membership_plans.sql
CREATE TABLE membership_plans (
  id                               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                             TEXT        NOT NULL UNIQUE,  -- 'free' | 'premium'
  monthly_ride_participation_limit INTEGER,                      -- NULL = unlimited (PREMIUM)
  max_riders_per_ride              INTEGER     NOT NULL,
  ride_history_days                INTEGER     NOT NULL,
  replay_enabled                   BOOLEAN     NOT NULL DEFAULT false,
  analytics_enabled                BOOLEAN     NOT NULL DEFAULT false,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 003_create_user_memberships.sql
CREATE TABLE user_memberships (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL REFERENCES users(id),
  plan_id    UUID        NOT NULL REFERENCES membership_plans(id),
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 004_create_rides.sql
CREATE TABLE rides (
  id                       UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  title                    TEXT              NOT NULL,
  status                   TEXT              NOT NULL DEFAULT 'LOBBY',
  -- status: LOBBY | ACTIVE | PAUSED | COMPLETED
  leader_id                TEXT              NOT NULL REFERENCES users(id),
  invite_code              VARCHAR(6)        NOT NULL,
  destination_name         TEXT              NOT NULL,
  destination_lat          DOUBLE PRECISION  NOT NULL,
  destination_lng          DOUBLE PRECISION  NOT NULL,
  route_polyline           TEXT              NOT NULL,
  -- INTERNAL ONLY — never returned to clients. iOS calculates via MKDirections and sends on create.
  distance_meters          DOUBLE PRECISION  NOT NULL,
  estimated_duration_seconds INTEGER         NOT NULL,
  max_allowed_participants INTEGER           NOT NULL,
  membership_snapshot      JSONB             NOT NULL,
  -- snapshot of { monthlyLimit, maxRidersPerRide } at creation time
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  created_at               TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rides_invite_code_idx ON rides (invite_code);

-- 005_create_ride_waypoints.sql
CREATE TABLE ride_waypoints (
  id         UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  "order"    INTEGER          NOT NULL,
  name       TEXT             NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  type       TEXT             NOT NULL,
  -- type: STOP | FUEL | FOOD | SCENIC | DESTINATION
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- 006_create_ride_participants.sql
CREATE TABLE ride_participants (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id              UUID        NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id              TEXT        NOT NULL REFERENCES users(id),
  status               TEXT        NOT NULL DEFAULT 'JOINED',
  -- status: JOINED | READY | ACTIVE | DISCONNECTED | LEFT
  counted_toward_quota BOOLEAN     NOT NULL DEFAULT false,
  quota_consumed_at    TIMESTAMPTZ,
  ride_title           TEXT,
  -- RIDE_LEADER | PACE_KEEPER | TRAIL_GUARDIAN | FORMATION_RIDER
  sync_score           INTEGER,    -- 0-100, populated on ride end
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ride_id, user_id)
);

-- 007_create_ride_summaries.sql
CREATE TABLE ride_summaries (
  id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id                UUID             NOT NULL UNIQUE REFERENCES rides(id),
  duration_seconds       INTEGER          NOT NULL,
  distance_meters        DOUBLE PRECISION NOT NULL,
  avg_speed_kmh          DOUBLE PRECISION,         -- NULL if duration = 0
  max_group_split_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
  compactness_score      DOUBLE PRECISION NOT NULL DEFAULT 0,  -- 0.0–1.0
  total_regroups         INTEGER          NOT NULL DEFAULT 0,
  total_emergencies      INTEGER          NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- 008_create_regroup_events.sql
CREATE TABLE regroup_events (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  created_by  TEXT             NOT NULL REFERENCES users(id),
  type        TEXT             NOT NULL,  -- FUEL | FOOD | SCENIC | STOP
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- 009_create_emergency_events.sql
CREATE TABLE emergency_events (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID             NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id     TEXT             NOT NULL REFERENCES users(id),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  message     TEXT             NOT NULL,
  resolved    BOOLEAN          NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- 010_seed_membership_plans.sql
INSERT INTO membership_plans (code, monthly_ride_participation_limit, max_riders_per_ride, ride_history_days, replay_enabled, analytics_enabled)
VALUES
  ('free',    10,   5,  30,  false, false),
  ('premium', NULL, 25, 365, false, true)
ON CONFLICT (code) DO NOTHING;
```

---

## Auth Architecture

**iOS app authenticates directly with Clerk** — our backend has zero auth endpoints.

Flow:
1. iOS calls Clerk SDK → gets JWT session token
2. iOS attaches JWT to every request: `Authorization: Bearer <token>`
3. Backend middleware calls `verifyToken(token)` → extracts `userId`
4. `userId` is attached to `request.user` (REST) or `socket.data.userId` (Socket.IO)

On every successful auth, upsert the user:
```sql
INSERT INTO users (id, name, avatar_url, created_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (id) DO NOTHING;
```
Name and avatar_url come from Clerk JWT claims (`firstName + ' ' + lastName`, `imageUrl`).

Socket.IO: client passes `{ auth: { token: '<JWT>' } }` on connect.

---

## Invite Code Generation

```typescript
// Charset excludes ambiguous chars: 0, O, I, L
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 32 chars

function generateInviteCode(): string {
  const bytes = crypto.randomBytes(4);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARSET[bytes[i % 4] % 32];
  }
  return code;
}
// Retry once on UNIQUE constraint violation on insert
```

Share link format (custom URL scheme — no paid Apple Developer account needed):
`convoy://join/{inviteCode}`

---

## REST Endpoints

All routes require `Authorization: Bearer <JWT>` except GET /health.

### GET /health
```
Response 200: { ok: true }
```

### POST /rides
```
Request body:
{
  title: string,
  destinationName: string,
  destinationLat: number,
  destinationLng: number,
  routePolyline: string,        // Google-encoded, calculated by iOS via MKDirections
  distanceMeters: number,       // from MKRoute.distance
  estimatedDurationSeconds: number, // from MKRoute.expectedTravelTime
  maxAllowedParticipants: number,
  waypoints: [
    { order: number, name: string, lat: number, lng: number, type: "STOP|FUEL|FOOD|SCENIC|DESTINATION" }
  ]
}

Response 200: { rideId: string, inviteCode: string }
Response 400: { error: "INVALID_WAYPOINTS" }  // missing DESTINATION type
Response 403: { error: "QUOTA_EXCEEDED", used: number, limit: number }
```

### GET /rides/join/:inviteCode
```
Response 200: { rideId, title, leaderName, participantCount, maxParticipants, status: "LOBBY" }
Response 404: { error: "INVITE_CODE_NOT_FOUND" }
Response 409: { error: "RIDE_NOT_IN_LOBBY", status: string }
```

### GET /rides/:rideId
```
Response 200:
{
  id, title, status, leaderId, inviteCode,
  destinationName, destinationLat, destinationLng,
  distanceMeters, estimatedDurationSeconds, maxAllowedParticipants,
  startedAt, endedAt, createdAt,
  waypoints: [{ id, order, name, lat, lng, type }],
  participants: [{ userId, name, avatarUrl, status, isLeader, joinedAt }]
}
NOTE: routePolyline is intentionally absent — iOS reconstructs route via MKDirections from waypoints[]
Response 404: { error: "RIDE_NOT_FOUND" }
```

### POST /rides/:rideId/join
```
Response 200: { ok: true }
Response 404: { error: "RIDE_NOT_FOUND" }
Response 409: { error: "RIDE_NOT_IN_LOBBY" }
Response 409: { error: "ALREADY_JOINED" }
Response 409: { error: "RIDE_FULL", maxAllowed: number, current: number }
Response 403: { error: "QUOTA_EXCEEDED", used: number, limit: number }
```

### POST /rides/:rideId/start
```
Leader only.
Runs in DB transaction: UPDATE status=ACTIVE + markQuotaConsumed for all JOINED/READY participants.
After commit: initialize ActiveRideState, decode routePolyline into LatLng[] + cumulative distances.
Emit ride:state_update to socket room.

Response 200: { ok: true }
Response 403: { error: "NOT_LEADER" }
Response 409: { error: "RIDE_NOT_IN_LOBBY" }
```

### POST /rides/:rideId/pause
```
Leader only.
Response 200: { ok: true }
Response 403: { error: "NOT_LEADER" }
Response 409: { error: "RIDE_NOT_ACTIVE" }
```

### POST /rides/:rideId/resume
```
Leader only.
Response 200: { ok: true }
Response 403: { error: "NOT_LEADER" }
Response 409: { error: "RIDE_NOT_PAUSED" }
```

### POST /rides/:rideId/end
```
Leader only.
Sequence: UPDATE status=COMPLETED → generate summary → assign titles → assign sync scores
          → delete from rideStore → emit ride:ride_ended to room.
Response 200: { ok: true, rideId: string }
Response 403: { error: "NOT_LEADER" }
Response 409: { error: "RIDE_NOT_ACTIVE_OR_PAUSED" }
```

### GET /rides/:rideId/summary
```
Response 200:
{
  rideId, durationSeconds, distanceMeters, avgSpeedKmh,
  maxGroupSplitMeters, compactnessScore,  // compactnessScore: 0-100 (multiply DB 0.0-1.0 by 100)
  totalRegroups, totalEmergencies, createdAt,
  participants: [{ userId, name, avatarUrl, rideTitle, syncScore }]
}
Response 404: { error: "RIDE_NOT_FOUND" }
Response 409: { error: "RIDE_NOT_COMPLETED" }
```

---

## Socket.IO Events

### Client → Server

**ride:join**
```typescript
socket.emit('ride:join', { rideId: string })
// Validates user is a DB participant. Joins room ride:{rideId}.
// Sends full current ActiveRideState snapshot back to this socket.
// Broadcasts ride:participant_joined to room.
```

**ride:leave**
```typescript
socket.emit('ride:leave', { rideId: string })
// Leaves room. Sets status=LEFT in DB + memory.
// Broadcasts ride:participant_left to room.
```

**ride:ready** (ack)
```typescript
socket.emit('ride:ready', { rideId: string }, (ack) => {
  // ack: { ok: true, participantCount: number, allReady: boolean }
  //   or { ok: false, error: "NOT_IN_RIDE | RIDE_NOT_LOBBY | UNAUTHORIZED" }
})
// Also broadcasts ride:participant_ready to room (excluding sender)
```

**ride:location_update**
```typescript
socket.emit('ride:location_update', {
  rideId: string,
  lat: number,
  lng: number,
  speed: number,          // km/h
  heading: number,        // degrees 0-360
  timestamp: string,      // ISO8601
  battery: number | null, // 0-100
  signalStrength: 'STRONG' | 'MODERATE' | 'WEAK' | null
})
// Validates ride is ACTIVE. Updates ActiveRideState.
// Runs progress engine → leaderboard engine → split detection → compactness sampling.
// Enqueues broadcast (throttled 1/sec per ride). NO DB writes.
```

**ride:regroup** (ack)
```typescript
socket.emit('ride:regroup', { rideId: string, type: 'FUEL' | 'FOOD' | 'SCENIC' | 'STOP', lat: number, lng: number }, (ack) => {
  // ack: { ok: true, regroupId: string }
})
// type=EMERGENCY is rejected — use ride:emergency instead.
// Only one open regroup at a time (overrides previous).
// Broadcasts ride:regroup_started to room.
```

**ride:emergency** (ack)
```typescript
socket.emit('ride:emergency', { rideId: string, lat: number, lng: number, message: string }, (ack) => {
  // ack: { ok: true, emergencyId: string }
})
// Multiple concurrent emergencies allowed.
// Works even during PAUSED state.
// Broadcasts ride:emergency_started with priority: 'CRITICAL'.
```

### Server → Client (Broadcasts)

**ride:state_update** — throttled max 1/sec per ride
```typescript
{
  rideId: string,
  status: 'LOBBY' | 'ACTIVE' | 'PAUSED' | 'COMPLETED',
  participants: [{
    userId, lat, lng, speed, heading, progress, offRoute, updatedAt,
    battery: number | null,
    signalStrength: 'STRONG' | 'MODERATE' | 'WEAK' | null
  }],
  leaderboard: [{
    rank: number,
    userId: string,
    name: string,
    progress: number,       // meters along route
    gapMeters: number,      // leader.progress - rider.progress
    positionDelta: number,  // +1, -1, or 0
    title: string | null
  }]
}
```

**ride:participant_joined** `{ userId, name, avatarUrl }`
**ride:participant_left** `{ userId }`
**ride:participant_ready** `{ userId, participantCount, allReady }` (excludes sender)
**ride:paused** `{ rideId, pausedAt }`
**ride:resumed** `{ rideId, resumedAt }`
**ride:ride_ended** `{ rideId, summaryAvailable: true }`
**ride:split_detected** `{ gapMeters, leaderId, lastRiderId }` (fires when gap > SPLIT_THRESHOLD_METERS=5000)
**ride:split_resolved** `{ gapMeters }`
**ride:regroup_started** `{ regroupId, createdBy, type, lat, lng, createdAt }`
**ride:regroup_resolved** `{ regroupId, resolvedAt }`
**ride:emergency_started** `{ emergencyId, userId, lat, lng, message, createdAt, priority: 'CRITICAL' }`

---

## In-Memory Ride State (ActiveRideState)

```typescript
interface ParticipantState {
  userId: string;
  name: string;
  avatarUrl: string | null;
  status: 'JOINED' | 'READY' | 'ACTIVE' | 'DISCONNECTED' | 'LEFT';
  lat: number | null;
  lng: number | null;
  speed: number | null;
  heading: number | null;
  progress: number;         // metres along route
  offRoute: boolean;
  battery: number | null;
  signalStrength: 'STRONG' | 'MODERATE' | 'WEAK' | null;
  updatedAt: string | null;
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  progress: number;
  gapMeters: number;
  positionDelta: number;
  title: string | null;
}

interface ActiveRideState {
  rideId: string;
  status: 'LOBBY' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  leaderId: string;
  distanceMeters: number;

  // Route (decoded once on ride start, internal only)
  routePoints: { lat: number; lng: number }[];
  cumulativeDist: number[];   // Haversine cumulative distances

  // Participants
  participants: Map<string, ParticipantState>;

  // Leaderboard
  leaderboard: LeaderboardEntry[];

  // Split detection
  splitActive: boolean;

  // Compactness score (group-level)
  spreadSampleSum: number;
  spreadSampleCount: number;

  // Per-rider gap accumulator (for sync scores on ride end)
  perRiderGapAccumulator: Map<string, { gapSum: number; gapCount: number }>;

  // Regroup
  openRegroup: {
    regroupId: string;
    lat: number;
    lng: number;
    arrivedRiders: Set<string>;
  } | null;
}
```

---

## Progress Engine (ENG-2)

```
Input:  rider { lat, lng }, routePoints[], cumulativeDist[]
Output: { progress: number (metres), offRoute: boolean }

Algorithm:
  For each segment (routePoints[i] → routePoints[i+1]):
    project rider position onto segment using point-to-segment formula
    compute distance from rider to projected point
    if distance < currentMin:
      currentMin = distance
      bestProgress = cumulativeDist[i] + distAlongSegment

  offRoute = currentMin > OFF_ROUTE_THRESHOLD_METERS (default 75)
  return { progress: bestProgress, offRoute }
```

---

## Leaderboard Engine (ENG-3)

```
1. Filter participants: status ACTIVE or READY only
2. Sort by progress DESC
3. Assign rank (1-indexed)
4. For each rider:
   gapMeters = leader.progress - rider.progress (floored at 0)
   positionDelta = previousRank - currentRank (+ means moved up)
5. Update perRiderGapAccumulator[userId].gapSum += gapMeters, .gapCount++
6. Update spreadSampleSum += (1 - min(maxGap, totalDist) / totalDist)
   spreadSampleCount++
7. Check split: if leader.progress - lastRider.progress > SPLIT_THRESHOLD_METERS
```

---

## Summary Generation (on ride end)

```typescript
// Called from POST /rides/:rideId/end

// 1. Ride Summary
durationSeconds = (ended_at - started_at) in seconds
avgSpeedKmh = durationSeconds > 0 ? (distanceMeters / durationSeconds) * 3.6 : null
compactnessScore = spreadSampleCount > 0 ? spreadSampleSum / spreadSampleCount : 1.0
INSERT INTO ride_summaries (...)

// 2. Ride Titles
RIDE_LEADER    → ride.leader_id
PACE_KEEPER    → lowest avgGap excluding leader (tie: earliest joined_at)
TRAIL_GUARDIAN → lowest final progress excluding leader (tie: lowest progress wins)
FORMATION_RIDER → all others
UPDATE ride_participants SET ride_title = $1 WHERE ride_id=$2 AND user_id=$3

// 3. Per-rider sync scores
for each userId in perRiderGapAccumulator:
  avgGap = gapSum / gapCount
  syncScore = clamp(round((1 - avgGap / distanceMeters) * 100), 0, 100)
leader syncScore = 100 always
solo ride: only leader entry, syncScore = 100
UPDATE ride_participants SET sync_score = $1 WHERE ride_id=$2 AND user_id=$3
```

---

## Quota Logic

```
FREE plan:  monthly_ride_participation_limit = 10
PREMIUM:    monthly_ride_participation_limit = NULL (unlimited)

canUserParticipate(userId):
  count = SELECT COUNT(*) FROM ride_participants rp
          JOIN rides r ON r.id = rp.ride_id
          WHERE rp.user_id = $1
            AND rp.counted_toward_quota = true
            AND date_trunc('month', rp.quota_consumed_at) = date_trunc('month', now())

  if plan.monthly_ride_participation_limit IS NULL → allowed: true
  if count >= limit → allowed: false

Quota is consumed (counted_toward_quota=true, quota_consumed_at=now())
inside the same DB transaction as POST /rides/:rideId/start.
counted_toward_quota stays false at join time.
```

---

## Disconnect Handling

```
On socket disconnect:
  - Set participant status = DISCONNECTED in ActiveRideState (memory only)
  - Start 30s timer
  - If not reconnected within 30s: UPDATE ride_participants SET status='DISCONNECTED'

On reconnect (ride:join to an active ride):
  - Restore full ActiveRideState snapshot to client
  - Set status = ACTIVE in memory
  - Emit ride:participant_joined to room
  - If ride ended during disconnect: include ride:ride_ended in snapshot
```

---

## Regroup Auto-Resolution

```
On every ride:location_update:
  if openRegroup exists:
    dist = Haversine(rider.lat, rider.lng, openRegroup.lat, openRegroup.lng)
    if dist <= 100:
      openRegroup.arrivedRiders.add(userId)
      if all ACTIVE participants in arrivedRiders:
        UPDATE regroup_events SET resolved_at = now()
        clear openRegroup from ActiveRideState
        emit ride:regroup_resolved to room
```

---

## Ride Title Display Mapping (iOS side, not backend)

Backend stores enum strings. iOS maps client-side:
```
"RIDE_LEADER"     → "RIDE LEADER"
"PACE_KEEPER"     → "PACE KEEPER"
"TRAIL_GUARDIAN"  → "TRAIL GUARDIAN"
"FORMATION_RIDER" → "FORMATION RIDER"
```

---

## Build Order (P0 first)

1. INFRA-1: Project scaffold (Fastify + TypeScript + folder structure)
2. INFRA-2: PostgreSQL connection + run migrations
3. INFRA-4: In-memory rideStore with full ActiveRideState type
4. AUTH-1: Clerk JWT middleware (REST)
5. AUTH-2: Socket.IO JWT auth on handshake
6. AUTH-3: User upsert on first auth
7. DB-2: Ride repository layer (including getRideByInviteCode)
8. DB-3: Participant repository layer
9. DB-4: Membership repository layer
10. QUOTA-1: Seed FREE + PREMIUM plans
11. QUOTA-2: canUserParticipate service
12. QUOTA-3: Rider count limit enforcement
13. INV-1: Invite code generation
14. RIDE-1: POST /rides
15. INV-2: GET /rides/join/:inviteCode
16. RIDE-2: POST /rides/:rideId/join
17. RT-1: Socket.IO server setup
18. RT-2: ride:join + ride:leave handlers
19. ENG-1: Route polyline decode + cache
20. ENG-2: Progress engine
21. QUOTA-4: Batch quota consumption
22. RIDE-3: POST /rides/:rideId/start
23. RT-4: ride:location_update handler
24. ENG-3: Leaderboard engine (+ ENG-7 gap accumulation)
25. RT-6: ride:state_update broadcaster (throttled 1/sec)
26. ENG-4: Group split detection (SPLIT_THRESHOLD=5000m)
27. ENG-6: Compactness score sampling
28. RT-5: Disconnect + reconnect handling
29. RG-3: ride:emergency handler
30. RIDE-6: POST /rides/:rideId/end
31. SUM-2: Ride summary generator (avgSpeedKmh included)
32. SUM-3: Ride title assignment
33. SUM-7: Per-rider sync score assignment
34. RIDE-7: GET /rides/:rideId
35. SUM-4: GET /rides/:rideId/summary
36. RT-3: ride:ready handler (ack pattern)
37. RIDE-4: POST /rides/:rideId/pause
38. RIDE-5: POST /rides/:rideId/resume
39. RG-1: ride:regroup handler
40. RG-2: Regroup auto-resolution
41. INFRA-3: Railway deployment config (optional)
42. INFRA-5: Global error handler + request logging

---

## Key Decisions (do not revisit without good reason)

- `route_polyline` is stored in the DB but **never returned** in any response. iOS clients reconstruct routes via MKDirections from `waypoints[]`.
- Emergency option in the iOS regroup sheet emits `ride:emergency`, NOT `ride:regroup`. Backend RG-1 rejects `type=EMERGENCY`.
- No PTT / voice / audio features. Out of scope permanently.
- Invite links use custom URL scheme `convoy://join/{inviteCode}`, not universal links (no paid Apple Developer account required).
- SPLIT_THRESHOLD_METERS = **5000** (not 2000 as in earlier drafts).
- iOS-only for now. No CORS configuration needed for native app. Add when web/Android clients arrive.
- Rider title display names are mapped client-side on iOS. Backend stores raw enum strings.
