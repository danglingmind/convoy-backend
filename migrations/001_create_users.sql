CREATE TABLE users (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
