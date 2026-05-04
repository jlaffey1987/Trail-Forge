-- TrailForge — Normalized route → trails join.
-- Apply via the Supabase SQL editor after 0022_route_comments_align.sql.
--
-- Until now `saved_routes.trail_ids` carried the ordered list of
-- trail uuids as a denormalised jsonb array. This migration introduces
-- the proper relational form requested by the route-task contract:
--
--   route_trails(route_id, position, trail_id)
--
--   * (route_id, position) is the primary key — order is meaningful.
--   * `position` is a 0-based index assigned at write time, so a route
--     reads back exactly the way the planner saved it.
--   * `trail_id` is text (matches `trails.id`), with a CASCADE FK so
--     a deleted route also drops its join rows.
--
-- The `saved_routes.trail_ids` column is KEPT for now as a redundant
-- mirror so a partial deploy (server old, db new — or vice versa)
-- can't lose data. The API writes both; reads prefer `route_trails`
-- and fall back to `trail_ids` only when the join table is empty
-- (e.g. a row written before this migration ran). A future cleanup
-- migration can drop `trail_ids` once we're confident no callers rely
-- on it.

CREATE TABLE IF NOT EXISTS route_trails (
  route_id  uuid NOT NULL REFERENCES saved_routes(id) ON DELETE CASCADE,
  position  integer NOT NULL CHECK (position >= 0),
  trail_id  text NOT NULL,
  PRIMARY KEY (route_id, position)
);

-- Hot path: "give me the trail ids for these route ids, ordered".
-- Covered by the PK; an additional index on (route_id) is implied.

-- Backfill from existing saved_routes rows. Uses jsonb_array_elements
-- with WITH ORDINALITY so the original order is preserved. Skips rows
-- that already have route_trails entries so the migration is safe to
-- re-run.
INSERT INTO route_trails (route_id, position, trail_id)
SELECT
  sr.id,
  (idx - 1)::integer,
  trail_value::text
FROM saved_routes sr
CROSS JOIN LATERAL jsonb_array_elements_text(sr.trail_ids)
  WITH ORDINALITY AS t(trail_value, idx)
WHERE sr.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM route_trails rt WHERE rt.route_id = sr.id
  );

-- ---------- RLS ----------
ALTER TABLE route_trails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_trails_anon_no_access ON route_trails;
-- (no policies — service role bypasses RLS, anon has nothing.)
