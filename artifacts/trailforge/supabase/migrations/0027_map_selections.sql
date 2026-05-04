-- TrailForge — Cloud-backed map selection per signed-in user.
-- Apply via: pnpm --filter @workspace/trailforge run db:migrate 0027_map_selections.sql
--
-- Mirrors planner_routes (migration 0012) but for the Map-tab trail
-- selection. Lets signed-in users restore their map selection across
-- devices / browser clears. The API server reads/writes this table
-- via /api/me/map-selection (service role, Clerk-authenticated).
--
-- Schema:
--   * map_selections.user_id    — Clerk user id (text), PK & FK to users.id
--   * map_selections.trail_ids  — ordered jsonb array of trail uuid strings
--   * map_selections.updated_at — last sync timestamp

CREATE TABLE IF NOT EXISTS map_selections (
  user_id    text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trail_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- RLS ----------
ALTER TABLE map_selections ENABLE ROW LEVEL SECURITY;

-- No anon policies — service role bypasses RLS, so all reads/writes go
-- through the API server (`/api/me/map-selection`).
