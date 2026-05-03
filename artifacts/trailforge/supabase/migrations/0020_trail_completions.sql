-- TrailForge — Trail completions ("ridden" log).
-- Apply via the Supabase SQL editor after 0019_phantom_ai_trails_cleanup.sql.
--
-- Each row records that a Clerk-authenticated rider has marked a trail
-- as ridden. One row per (user, trail) — re-marking simply updates the
-- timestamp/note via upsert. Unmarking deletes the row.
--
-- Schema:
--   * id            — uuid PK
--   * user_id       — Clerk user id (text), FK to users.id (cascade)
--   * trail_id      — FK to trails.id (cascade)
--   * completed_at  — when the rider says they rode it (defaults to now)
--   * note          — short optional rider note (≤500 chars)
--   * created_at    — when the row was first written
--
-- Anon-key clients have NO access; all reads/writes go through
-- `/api/me/completions` which authenticates via Clerk.

CREATE TABLE IF NOT EXISTS trail_completions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trail_id      uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trail_completions_user_trail_unique
  ON trail_completions (user_id, trail_id);

CREATE INDEX IF NOT EXISTS trail_completions_user_completed_at_idx
  ON trail_completions (user_id, completed_at DESC);

-- ---------- RLS ----------
ALTER TABLE trail_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trail_completions_owner_read   ON trail_completions;
DROP POLICY IF EXISTS trail_completions_owner_insert ON trail_completions;
DROP POLICY IF EXISTS trail_completions_owner_update ON trail_completions;
DROP POLICY IF EXISTS trail_completions_owner_delete ON trail_completions;

-- No anon policies — service role bypasses RLS, so all reads/writes go
-- through the API server (`/api/me/completions`).
