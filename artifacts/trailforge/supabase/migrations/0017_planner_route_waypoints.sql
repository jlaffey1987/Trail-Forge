-- TrailForge — Custom waypoints (fuel/campsite/custom stops) on planner routes.
-- Apply via the Supabase SQL editor after 0016_group_photos.sql.
--
-- Phase A (migration 0012) only persisted an ordered `trail_ids` array.
-- The Planner now lets riders drop arbitrary stops along the route — a
-- petrol station picked from the Overpass POI overlay, a campsite they
-- want to overnight at, or a custom pin. These need their own coordinates
-- and metadata, so we store them as a parallel jsonb array PLUS an
-- ordered "entry_order" array of `{kind:'trail'|'waypoint', id}` refs
-- so the client can reconstruct the exact interleave (trail → waypoint →
-- trail → waypoint → trail) the user built.
--
-- Why two columns instead of merging trail_ids into entry_order?
--   * Backwards compatibility: legacy clients still PUT plain `trailIds`
--     bodies. The server keeps writing `trail_ids` so an old build keeps
--     working. The new client always sends `trailIds + waypoints +
--     entryOrder` together.
--   * Cheaper to query trail visibility — we still join `trails` by id
--     using the `trail_ids` array directly, no extra unnesting.
--
-- Both new columns default to empty arrays so existing rows are valid
-- without backfill.

ALTER TABLE planner_routes
  ADD COLUMN IF NOT EXISTS waypoints   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS entry_order jsonb NOT NULL DEFAULT '[]'::jsonb;

-- No new RLS policies needed — planner_routes already restricts all
-- access to the service role / API server (see 0012_planner_routes.sql).
