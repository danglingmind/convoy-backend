-- Paywall / upsell funnel events: which surface opened the paywall and whether the rider bought.
-- Deleted with the account.
CREATE TABLE paywall_events (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT,
  name         TEXT        NOT NULL,
  source       TEXT,
  access       TEXT,
  platform     TEXT        NOT NULL,
  app_version  TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX paywall_events_name_time ON paywall_events (name, occurred_at);
CREATE INDEX paywall_events_user ON paywall_events (user_id);
