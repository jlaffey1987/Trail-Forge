-- TrailForge — clean up legacy phantom AI placeholder trails and prevent
-- new ones from ever being persisted at the DB layer.
--
-- Background
-- ----------
-- Before the AI forum scanner was tightened up, whenever it had no GPX
-- attachment and could not snap to a real OSM way, it persisted a
-- ruler-straight 2-point ~500 m placeholder trail (lat+0.005°, identical
-- longitude). Those rows are visual noise on the map and confuse stats /
-- search even though they carry the dashed `ai-approximated` styling.
--
-- The trailforge client and API server already filter them out at fetch
-- time via `isSyntheticPlaceholderTrail` / `isLegacySyntheticPlaceholder`,
-- but the rows themselves still take up space, count toward stats, and
-- show up in any direct admin tooling. This migration:
--
--   1. Soft-deletes every existing trail row that matches the legacy
--      placeholder shape (sets `deleted_at = now()`), so the public RLS
--      policy and the standard `deleted_at IS NULL` filters hide them
--      everywhere — not just in the two helpers that know about the shape.
--
--   2. Adds a CHECK constraint that rejects any future INSERT or UPDATE
--      whose row matches the same shape, so we don't silently grow the
--      pile again if a regression slips into the AI scanner. The
--      constraint mirrors `isSyntheticPlaceholderTrail`:
--          verification_status = 'ai-approximated'
--          AND (path_point_count IS NULL OR path_point_count = 2)
--          AND all four bbox columns are present
--          AND |lngSpan| < 1e-6
--          AND |latSpan| × 111_320 BETWEEN 400 AND 700  (the 0.005° offset)
--
-- Idempotent: the UPDATE only touches still-live rows, and the constraint
-- creation is guarded by a NOT EXISTS check so re-running is safe.

-- ---------- 1. Soft-delete existing phantoms ----------
WITH targets AS (
  SELECT id
  FROM public.trails
  WHERE deleted_at IS NULL
    AND verification_status = 'ai-approximated'
    AND (path_point_count IS NULL OR path_point_count = 2)
    AND bbox_min_lat IS NOT NULL
    AND bbox_max_lat IS NOT NULL
    AND bbox_min_lng IS NOT NULL
    AND bbox_max_lng IS NOT NULL
    AND abs(bbox_max_lng - bbox_min_lng) < 1e-6
    AND (abs(bbox_max_lat - bbox_min_lat) * 111320) BETWEEN 400 AND 700
)
UPDATE public.trails t
   SET deleted_at = now()
  FROM targets
 WHERE t.id = targets.id;

-- ---------- 2. Reject future phantoms ----------
-- A CHECK constraint cannot reference subqueries but can reference the
-- row's own columns, which is all we need. NOT VALID would let legacy
-- rows linger; we just soft-deleted them above so we can validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trails_no_phantom_ai_placeholder'
  ) THEN
    ALTER TABLE public.trails
      ADD CONSTRAINT trails_no_phantom_ai_placeholder
      CHECK (
        NOT (
          verification_status = 'ai-approximated'
          AND (path_point_count IS NULL OR path_point_count = 2)
          AND bbox_min_lat IS NOT NULL
          AND bbox_max_lat IS NOT NULL
          AND bbox_min_lng IS NOT NULL
          AND bbox_max_lng IS NOT NULL
          AND abs(bbox_max_lng - bbox_min_lng) < 1e-6
          AND (abs(bbox_max_lat - bbox_min_lat) * 111320) BETWEEN 400 AND 700
          AND deleted_at IS NULL
        )
      );
  END IF;
END $$;
