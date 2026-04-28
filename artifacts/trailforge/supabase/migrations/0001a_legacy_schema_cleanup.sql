-- TrailForge — pre-migration cleanup of the original Drizzle scaffold schema.
-- Apply BEFORE migration 0002_users_and_owner.sql.
--
-- The original Supabase project was scaffolded with a `users` table whose
-- primary key was `uuid`, plus FKs from `trails.user_id` and
-- `route_chains.user_id`. After Task #2 introduced Clerk-backed accounts
-- the new `users` table needs `id text` (Clerk user ids), so the legacy
-- table and its FK columns must be removed first. This file is safe
-- because:
--   * legacy `users` is empty (verified before applying)
--   * `trails.user_id` is NULL on every row
--   * `route_chains` is empty and is no longer referenced from app code
--
-- It also creates the `saved_trails` table that migrations 0002 / 0004
-- assume already exists. The original Drizzle schema never created one
-- because the saved-trails feature was added in Task #2.

-- 1. Drop legacy RLS policies that reference the old user_id column /
--    the Supabase-Auth `auth.uid()` helper. Migration 0003 will create
--    fresh, API-server-friendly policies in their place.
DROP POLICY IF EXISTS "Public trails are viewable by everyone" ON trails;
DROP POLICY IF EXISTS "Users can manage own trails" ON trails;

-- 2. Drop legacy ownership columns. CASCADE removes any remaining
--    indexes / FKs that depend on them.
ALTER TABLE trails        DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE route_chains  DROP COLUMN IF EXISTS user_id CASCADE;

-- 3. Drop the legacy uuid-keyed users table so the new text-keyed one can
--    be created by 0002. (Empty table — no data loss.)
DROP TABLE IF EXISTS users;

-- 4. Create saved_trails up-front so 0002 can ALTER it to add user_id.
CREATE TABLE IF NOT EXISTS saved_trails (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id    uuid        NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  session_id  text,
  status      text        NOT NULL DEFAULT 'planned',
  saved_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-session uniqueness (a guest can't save the same trail twice).
CREATE UNIQUE INDEX IF NOT EXISTS saved_trails_session_trail_unique
  ON saved_trails (session_id, trail_id)
  WHERE session_id IS NOT NULL;
