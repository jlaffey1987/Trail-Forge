-- TrailForge — Named/saved routes (a user can keep many).
-- Apply via the Supabase SQL editor after 0017_planner_route_waypoints.sql.
--
-- Until now `planner_routes` was a per-user singleton — exactly one
-- in-progress route per Clerk user. Riders kept asking for "save this
-- as 'Welsh Weekend Loop' so I can swap back to it next month" — this
-- table backs that. Each row is one named route the user has stored
-- away. Loading a saved route copies its trail_ids/waypoints/entry_order
-- back into `planner_routes` so the existing Map + Planner UIs work
-- unchanged; this table is purely the persistent library.
--
-- Schema:
--   * id              — uuid, generated server-side
--   * user_id         — Clerk user id (text), FK to users.id
--   * name            — short display name (≤200 chars)
--   * trail_ids       — ordered jsonb array of trail uuid strings.
--                       Same "not an FK array" tradeoff as planner_routes:
--                       trails get soft-deleted / made private; the
--                       hydrate step at fetch time filters those out.
--   * waypoints       — jsonb array of custom stops (mirrors
--                       planner_routes.waypoints).
--   * entry_order     — jsonb array of {kind,id} refs (mirrors
--                       planner_routes.entry_order) so the trail/
--                       waypoint interleave is restored exactly.
--   * distance_km     — denormalised total trail km at save time, so
--                       the My Trails listing can show "42.3 km" without
--                       re-hydrating GPX. Recomputed on next save.
--   * created_at      — when the rider first saved this route
--   * updated_at      — last time they renamed/overwrote it (currently
--                       only created — no edit endpoint yet).
--
-- Indexed on `user_id` so the "list my routes" query stays cheap as
-- the table grows. Anon-key clients have NO access; all reads/writes
-- go through `/api/me/saved-routes` which authenticates via Clerk.

CREATE TABLE IF NOT EXISTS saved_routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  trail_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
  waypoints    jsonb NOT NULL DEFAULT '[]'::jsonb,
  entry_order  jsonb NOT NULL DEFAULT '[]'::jsonb,
  distance_km  numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_routes_user_id_idx
  ON saved_routes (user_id, created_at DESC);

-- ---------- RLS ----------
ALTER TABLE saved_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_routes_owner_read   ON saved_routes;
DROP POLICY IF EXISTS saved_routes_owner_insert ON saved_routes;
DROP POLICY IF EXISTS saved_routes_owner_update ON saved_routes;
DROP POLICY IF EXISTS saved_routes_owner_delete ON saved_routes;

-- No anon policies — service role bypasses RLS, so all reads/writes go
-- through the API server (`/api/me/saved-routes`).
