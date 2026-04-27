-- TrailForge — User accounts foundation.
-- Apply via the Supabase SQL editor.
--
-- Adds:
--  * users table keyed by Clerk user id (text PK), mirrored from Clerk on first sign-in.
--  * owner_user_id column on trails for member-owned trails.
--  * user_id column on saved_trails so signed-in users get per-account bookmarks.
--    The existing session_id column is kept for backwards-compat / migration.

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,                  -- Clerk user id (e.g. "user_2abc...")
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- Trails: ownership column. NULL = community / system-imported.
ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS trails_owner_user_id_idx ON trails (owner_user_id);

-- Saved trails: per-user column alongside the existing session_id.
ALTER TABLE saved_trails
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS saved_trails_user_id_idx ON saved_trails (user_id);

-- Allow either session_id or user_id to identify a saved trail row, but require at least one.
-- (Existing rows with session_id remain valid until migrated.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'saved_trails_owner_present'
  ) THEN
    ALTER TABLE saved_trails
      ADD CONSTRAINT saved_trails_owner_present
      CHECK (user_id IS NOT NULL OR session_id IS NOT NULL);
  END IF;
END $$;
