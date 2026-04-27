-- TrailForge — bbox columns on trails for fast viewport queries.
-- Apply via the Supabase SQL editor.
--
-- Adds bounding-box columns derived from the GPX track and an index so the
-- Map tab can fetch only the trails whose bbox intersects the visible
-- viewport. A trigger keeps the bbox in sync on insert/update of gpx_data.

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS bbox_min_lat double precision,
  ADD COLUMN IF NOT EXISTS bbox_max_lat double precision,
  ADD COLUMN IF NOT EXISTS bbox_min_lng double precision,
  ADD COLUMN IF NOT EXISTS bbox_max_lng double precision;

CREATE INDEX IF NOT EXISTS trails_bbox_idx
  ON trails (bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng);

-- Compute bbox from a GPX <trkpt lat="..." lon="..."/> string.
CREATE OR REPLACE FUNCTION trails_compute_bbox(gpx text)
RETURNS TABLE (min_lat double precision, max_lat double precision,
               min_lng double precision, max_lng double precision) AS $$
DECLARE
  lats double precision[];
  lngs double precision[];
BEGIN
  IF gpx IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg((m[1])::double precision), array_agg((m[2])::double precision)
    INTO lats, lngs
  FROM regexp_matches(
    gpx,
    '<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"',
    'g'
  ) AS m;

  IF lats IS NULL OR array_length(lats, 1) IS NULL THEN
    RETURN;
  END IF;

  min_lat := (SELECT min(x) FROM unnest(lats) AS x);
  max_lat := (SELECT max(x) FROM unnest(lats) AS x);
  min_lng := (SELECT min(x) FROM unnest(lngs) AS x);
  max_lng := (SELECT max(x) FROM unnest(lngs) AS x);
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger: keep bbox columns in sync with gpx_data.
CREATE OR REPLACE FUNCTION trails_set_bbox() RETURNS trigger AS $$
DECLARE
  b record;
BEGIN
  IF NEW.gpx_data IS NULL THEN
    NEW.bbox_min_lat := NULL;
    NEW.bbox_max_lat := NULL;
    NEW.bbox_min_lng := NULL;
    NEW.bbox_max_lng := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO b FROM trails_compute_bbox(NEW.gpx_data::text) LIMIT 1;
  IF FOUND THEN
    NEW.bbox_min_lat := b.min_lat;
    NEW.bbox_max_lat := b.max_lat;
    NEW.bbox_min_lng := b.min_lng;
    NEW.bbox_max_lng := b.max_lng;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trails_bbox_trigger ON trails;
CREATE TRIGGER trails_bbox_trigger
  BEFORE INSERT OR UPDATE OF gpx_data ON trails
  FOR EACH ROW EXECUTE FUNCTION trails_set_bbox();

-- Backfill existing rows.
UPDATE trails t
SET bbox_min_lat = b.min_lat,
    bbox_max_lat = b.max_lat,
    bbox_min_lng = b.min_lng,
    bbox_max_lng = b.max_lng
FROM (
  SELECT id, (trails_compute_bbox(gpx_data::text)).*
  FROM trails
  WHERE gpx_data IS NOT NULL
) b
WHERE t.id = b.id;
