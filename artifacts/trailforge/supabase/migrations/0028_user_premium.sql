-- TrailForge — User premium tier + preferences.
-- Apply via the Supabase SQL editor (or via `supabase db push`).
--
-- Adds:
--  * users.is_premium        boolean flag set by an admin/webhook when a user pays.
--  * users.preferred_bike_type  persists the bike-type filter preference server-side.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_premium boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_bike_type text
    CHECK (preferred_bike_type IN ('all', 'adventure', 'trail', 'enduro'))
    DEFAULT 'all';
