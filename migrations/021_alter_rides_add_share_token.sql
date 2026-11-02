-- Public share link for a completed ride (https://convotrack.in/route/<token>). A separate
-- token, not the ride id or invite code, so the link exposes only the route payload and can be
-- switched off by the leader without touching the ride.
ALTER TABLE rides
  ADD COLUMN share_token   VARCHAR(12),
  ADD COLUMN share_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX rides_share_token_idx ON rides (share_token) WHERE share_token IS NOT NULL;
