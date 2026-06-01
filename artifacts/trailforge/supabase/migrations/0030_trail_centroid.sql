-- TrailForge — centroid, start/end geometry, and TET metadata columns on trails.
--
-- Apply via the Supabase SQL editor after 0029_tet_official_group.sql.
--
-- New columns:
--   centroid_lat / centroid_lon   double precision  — geographic centre of the
--                                                     trail for map marker placement.
--                                                     Derived from bbox midpoint on
--                                                     existing rows; the import script
--                                                     supplies it explicitly on new rows.
--   start_lat / start_lon         double precision  — first track point
--   end_lat   / end_lon           double precision  — last track point
--   tet_track                     text              — original TET GPX track name
--                                                     (e.g. "TET_UK-01-Borderlands_20250704")
--   tet_section_number            integer           — sequential section index within
--                                                     the source TET track (1-based)
--   is_seasonal                   boolean           — true when the TET name contains
--                                                     "Seasonal"; app shows a warning
--   flagged_for_review            boolean           — quality flag set by the import script
--   flag_reasons                  text[]            — array of human-readable flag messages

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS centroid_lat          double precision,
  ADD COLUMN IF NOT EXISTS centroid_lon          double precision,
  ADD COLUMN IF NOT EXISTS start_lat             double precision,
  ADD COLUMN IF NOT EXISTS start_lon             double precision,
  ADD COLUMN IF NOT EXISTS end_lat               double precision,
  ADD COLUMN IF NOT EXISTS end_lon               double precision,
  ADD COLUMN IF NOT EXISTS tet_track             text,
  ADD COLUMN IF NOT EXISTS tet_section_number    integer,
  ADD COLUMN IF NOT EXISTS is_seasonal           boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS flagged_for_review    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_reasons          text[];

-- ── Index for map marker queries by centroid ─────────────────────────────────
CREATE INDEX IF NOT EXISTS trails_centroid_idx
  ON trails (centroid_lat, centroid_lon)
  WHERE centroid_lat IS NOT NULL;

-- ── Backfill: derive centroid from bbox midpoint for all existing rows ────────
-- New rows inserted by the TET import script supply centroid_lat/lon directly.
-- This backfill handles everything imported before this migration was applied.
UPDATE trails
SET
  centroid_lat = (bbox_min_lat + bbox_max_lat) / 2.0,
  centroid_lon = (bbox_min_lng + bbox_max_lng) / 2.0
WHERE centroid_lat IS NULL
  AND bbox_min_lat IS NOT NULL
  AND bbox_max_lat IS NOT NULL
  AND bbox_min_lng IS NOT NULL
  AND bbox_max_lng IS NOT NULL;
