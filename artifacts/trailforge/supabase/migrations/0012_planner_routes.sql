-- TrailForge — Cloud-backed planner route per signed-in user.
-- Apply via the Supabase SQL editor after 0011_trail_elevation_profile.sql.
--
-- Until now the Map-tab Route panel + Planner shared a route stored
-- only in browser localStorage (`trailforge_planner_route`). That route
-- was lost whenever the user cleared their browser, switched devices,
-- or signed in fresh on the web. This migration adds a per-user table
-- so the API server (service role, Clerk-authenticated) can sync the
-- chosen trail order across devices.
--
-- Schema:
--   * planner_routes.user_id      — Clerk user id (text), PK & FK to users.id
--   * planner_routes.trail_ids    — ordered jsonb array of trail uuid strings
--                                   (NOT a fk array, because trails can be
--                                   soft-deleted or removed from public
--                                   visibility — the read endpoint filters
--                                   missing ids out at fetch time).
--   * planner_routes.updated_at   — last sync timestamp
--
-- Anon-key clients have NO access. All reads/writes go through
-- `/api/me/planner-route` which authenticates via Clerk and stamps
-- `user_id` server-side.

CREATE TABLE IF NOT EXISTS planner_routes (
  user_id    text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trail_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- RLS ----------
ALTER TABLE planner_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planner_routes_owner_read   ON planner_routes;
DROP POLICY IF EXISTS planner_routes_owner_insert ON planner_routes;
DROP POLICY IF EXISTS planner_routes_owner_update ON planner_routes;
DROP POLICY IF EXISTS planner_routes_owner_delete ON planner_routes;

-- No anon policies — service role bypasses RLS, so all reads/writes go
-- through the API server (`/api/me/planner-route`).
