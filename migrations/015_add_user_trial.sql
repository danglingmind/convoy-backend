-- App-level free trial. NULL = trial not started yet: it starts lazily (now() + 3 days) on the
-- user's first /users/me, create or join after TRIAL_ENFORCEMENT_ENABLED is switched on, so every
-- existing rider gets a fresh 3 days from release rather than from their original sign-up.
ALTER TABLE users ADD COLUMN trial_ends_at TIMESTAMPTZ;
