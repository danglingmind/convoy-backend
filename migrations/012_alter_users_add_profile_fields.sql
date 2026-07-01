ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username              TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS phone                 TEXT,
  ADD COLUMN IF NOT EXISTS phone_visible         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_contact         TEXT,
  ADD COLUMN IF NOT EXISTS email_contact_visible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_nearby_rides   BOOLEAN NOT NULL DEFAULT true;
