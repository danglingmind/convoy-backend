CREATE TABLE rides (
  id                         UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  title                      TEXT              NOT NULL,
  status                     TEXT              NOT NULL DEFAULT 'LOBBY',
  leader_id                  TEXT              NOT NULL REFERENCES users(id),
  invite_code                VARCHAR(6)        NOT NULL,
  destination_name           TEXT              NOT NULL,
  destination_lat            DOUBLE PRECISION  NOT NULL,
  destination_lng            DOUBLE PRECISION  NOT NULL,
  route_polyline             TEXT              NOT NULL,
  distance_meters            DOUBLE PRECISION  NOT NULL,
  estimated_duration_seconds INTEGER           NOT NULL,
  max_allowed_participants   INTEGER           NOT NULL,
  membership_snapshot        JSONB             NOT NULL,
  started_at                 TIMESTAMPTZ,
  ended_at                   TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rides_invite_code_idx ON rides (invite_code);
