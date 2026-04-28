-- TrailForge — ACT (Adventure Country Tracks) bundle importer support.
-- Apply via the Supabase SQL editor after 0008_trail_simplified_path.sql.
--
-- Adds two columns + a unique index used by the ACT importer:
--
--   * trails.source_region   text — `uk` | `italy` | `pyrenees` (or future
--                                   ACT regions). Allows the planner to
--                                   filter ACT trails by bundle without a
--                                   bbox query.
--
--   * trails.segment_hash    text — sha256 of (bundle hash | track index |
--                                   segment index | rounded points). Lets
--                                   re-runs of the importer be idempotent
--                                   without comparing geometry.
--
-- A unique partial index on `(source, source_url, segment_hash)` makes the
-- upsert in the importer deterministic — re-importing the same bundle is a
-- no-op, while a fresh ACT release (different `source_url` or shifted
-- geometry) inserts new rows.

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS source_region text,
  ADD COLUMN IF NOT EXISTS segment_hash  text;

CREATE INDEX IF NOT EXISTS trails_source_region_idx
  ON trails (source_region)
  WHERE source_region IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trails_source_segment_unique
  ON trails (source, source_url, segment_hash)
  WHERE segment_hash IS NOT NULL;
