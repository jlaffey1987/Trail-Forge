-- TrailForge — Row Level Security policies for the user-accounts data model.
-- Apply via the Supabase SQL editor after 0002_users_and_owner.sql.
--
-- Threat model: the browser holds the Supabase **anon** key only. All
-- ownership-sensitive reads / writes flow through the API server, which
-- uses the **service-role** key (and is therefore not subject to RLS).
-- The service role authenticates the caller via Clerk and stamps
-- `owner_user_id` / `user_id` itself, so we can lock down anon access
-- aggressively here without breaking the app.
--
-- Anon-key access surface, after this migration:
--   * trails       : SELECT only when `is_public = true`. NO INSERT /
--                    UPDATE / DELETE.
--   * saved_trails : NO access of any kind.
--   * users        : NO access of any kind.

-- ---------- users ----------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policies from earlier iterations of this migration.
DROP POLICY IF EXISTS users_self_select ON users;
DROP POLICY IF EXISTS users_self_upsert ON users;
DROP POLICY IF EXISTS users_self_update ON users;

-- No anon policies — service role bypasses RLS, so all reads/writes go
-- through the API server (`POST /api/me/sync`, etc.) and are gated by
-- Clerk authentication.

-- ---------- trails ----------
ALTER TABLE trails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trails_public_read ON trails;
DROP POLICY IF EXISTS trails_owner_read ON trails;
DROP POLICY IF EXISTS trails_insert ON trails;
DROP POLICY IF EXISTS trails_owner_update ON trails;
DROP POLICY IF EXISTS trails_owner_delete ON trails;

-- Public read: anyone can read trails marked public.
CREATE POLICY trails_public_read ON trails
  FOR SELECT
  TO anon, authenticated
  USING (is_public = true);

-- No anon INSERT/UPDATE/DELETE policies — those flow through
-- `POST /api/trails` (Clerk-required, server stamps owner_user_id).
-- The service role bypasses RLS for owner-scoped reads of private trails.

-- ---------- saved_trails ----------
ALTER TABLE saved_trails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_trails_owner_read ON saved_trails;
DROP POLICY IF EXISTS saved_trails_owner_insert ON saved_trails;
DROP POLICY IF EXISTS saved_trails_owner_update ON saved_trails;
DROP POLICY IF EXISTS saved_trails_owner_delete ON saved_trails;

-- No anon policies — all saved-trails reads/writes go through the API
-- server (`/api/me/saved-trails*`), which authenticates via Clerk for
-- signed-in users and validates the device `sessionId` for guests.
