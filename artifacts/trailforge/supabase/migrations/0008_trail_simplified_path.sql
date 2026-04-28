-- TrailForge — pre-simplified path columns on trails for instant Map rendering.
-- Apply via the Supabase SQL editor after 0007_ai_discovery.sql.
--
-- Adds two derived columns the Map tab can render directly, without parsing
-- the raw GPX XML on the device:
--
--   * simplified_path  text   — Google encoded polyline (precision 5).
--                              Compact and decoded in JS without an XML parse.
--   * path_geojson     jsonb  — GeoJSON LineString (`{type, coordinates}`),
--                              kept alongside the encoded form for any
--                              consumer that prefers the structured shape.
--   * path_point_count int    — number of points stored in the simplified path.
--
-- A trigger derives both columns from `gpx_data` on INSERT/UPDATE so the
-- normal upload pipeline (POST /trails, PUT /trails/:id/gpx) populates them
-- with no client-side change required. A backfill at the bottom of this file
-- fills the columns for trails that already exist.

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS simplified_path  text,
  ADD COLUMN IF NOT EXISTS path_geojson     jsonb,
  ADD COLUMN IF NOT EXISTS path_point_count integer;

-- ---------------------------------------------------------------------------
-- Helper: extract parallel lat/lng arrays from a GPX text body. Accepts
-- both <trkpt> and <rtept> so route-style GPX exports also populate.
-- Returns a single row when at least one point is found; otherwise zero rows
-- so callers using LATERAL skip the trail cleanly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trailforge_extract_lat_lng(gpx text)
RETURNS TABLE (lats double precision[], lngs double precision[]) AS $$
DECLARE
  out_lats double precision[];
  out_lngs double precision[];
BEGIN
  IF gpx IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg((m[1])::double precision),
         array_agg((m[2])::double precision)
    INTO out_lats, out_lngs
  FROM regexp_matches(
    gpx,
    '<(?:trkpt|rtept)[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"',
    'g'
  ) AS m;

  IF out_lats IS NULL OR array_length(out_lats, 1) IS NULL THEN
    RETURN;
  END IF;

  lats := out_lats;
  lngs := out_lngs;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ---------------------------------------------------------------------------
-- Helper: encode one signed integer using the Google polyline algorithm
-- (precision 5). Mirrors the JS reference implementation used by the
-- @googlemaps/polyline-codec package.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trailforge_encode_polyline_value(value bigint)
RETURNS text AS $$
DECLARE
  v      bigint;
  result text := '';
BEGIN
  IF value < 0 THEN
    v := ~(value << 1);
  ELSE
    v := value << 1;
  END IF;
  WHILE v >= 32 LOOP
    result := result || chr((((v & 31) | 32))::int + 63);
    v := v >> 5;
  END LOOP;
  result := result || chr(v::int + 63);
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ---------------------------------------------------------------------------
-- Helper: build the encoded polyline + GeoJSON LineString from full lat/lng
-- arrays. Stride-samples down to `max_points` so very long tracks (10k+
-- points) still produce a payload the Map tab can render in one frame, while
-- preserving the first/last points so endpoints remain accurate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trailforge_build_path(
  lats double precision[],
  lngs double precision[],
  max_points int DEFAULT 1500
)
RETURNS TABLE (
  encoded     text,
  geojson     jsonb,
  point_count int
) AS $$
DECLARE
  n             int;
  stride        int;
  i             int;
  prev_lat      bigint := 0;
  prev_lng      bigint := 0;
  cur_lat       bigint;
  cur_lng       bigint;
  enc           text   := '';
  chosen_lats   double precision[] := ARRAY[]::double precision[];
  chosen_lngs   double precision[] := ARRAY[]::double precision[];
  pc            int;
BEGIN
  IF lats IS NULL OR array_length(lats, 1) IS NULL OR array_length(lats, 1) < 2 THEN
    RETURN;
  END IF;

  n := array_length(lats, 1);
  stride := GREATEST(1, ceil(n::numeric / GREATEST(max_points, 2))::int);

  i := 1;
  WHILE i <= n LOOP
    chosen_lats := array_append(chosen_lats, lats[i]);
    chosen_lngs := array_append(chosen_lngs, lngs[i]);
    i := i + stride;
  END LOOP;

  -- Always include the final point so endpoint markers / route-builder
  -- handoff lat/lng stay accurate even when stride > 1.
  IF chosen_lats[array_upper(chosen_lats, 1)] IS DISTINCT FROM lats[n]
     OR chosen_lngs[array_upper(chosen_lngs, 1)] IS DISTINCT FROM lngs[n] THEN
    chosen_lats := array_append(chosen_lats, lats[n]);
    chosen_lngs := array_append(chosen_lngs, lngs[n]);
  END IF;

  pc := array_length(chosen_lats, 1);

  FOR i IN 1..pc LOOP
    cur_lat := round(chosen_lats[i] * 1e5)::bigint;
    cur_lng := round(chosen_lngs[i] * 1e5)::bigint;
    enc := enc
        || trailforge_encode_polyline_value(cur_lat - prev_lat)
        || trailforge_encode_polyline_value(cur_lng - prev_lng);
    prev_lat := cur_lat;
    prev_lng := cur_lng;
  END LOOP;

  encoded     := enc;
  point_count := pc;
  geojson     := jsonb_build_object(
    'type', 'LineString',
    'coordinates', (
      SELECT jsonb_agg(jsonb_build_array(chosen_lngs[s.i], chosen_lats[s.i]) ORDER BY s.i)
      FROM generate_series(1, pc) AS s(i)
    )
  );
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Trigger: keep simplified_path / path_geojson in sync with gpx_data.
-- Mirrors the trails_bbox_trigger pattern from migration 0001 so both derived
-- views of the geometry are rebuilt together when the GPX is replaced.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trails_set_simplified_path() RETURNS trigger AS $$
DECLARE
  pts   record;
  built record;
BEGIN
  IF NEW.gpx_data IS NULL THEN
    NEW.simplified_path  := NULL;
    NEW.path_geojson     := NULL;
    NEW.path_point_count := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO pts FROM trailforge_extract_lat_lng(NEW.gpx_data::text);
  IF pts IS NULL OR pts.lats IS NULL THEN
    NEW.simplified_path  := NULL;
    NEW.path_geojson     := NULL;
    NEW.path_point_count := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO built FROM trailforge_build_path(pts.lats, pts.lngs);
  IF built IS NULL OR built.encoded IS NULL THEN
    NEW.simplified_path  := NULL;
    NEW.path_geojson     := NULL;
    NEW.path_point_count := NULL;
  ELSE
    NEW.simplified_path  := built.encoded;
    NEW.path_geojson     := built.geojson;
    NEW.path_point_count := built.point_count;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trails_simplified_path_trigger ON trails;
CREATE TRIGGER trails_simplified_path_trigger
  BEFORE INSERT OR UPDATE OF gpx_data ON trails
  FOR EACH ROW EXECUTE FUNCTION trails_set_simplified_path();

-- ---------------------------------------------------------------------------
-- Backfill existing rows in one statement. Trails whose gpx_data is missing
-- or doesn't yield any waypoints are left with NULL simplified_path and the
-- Map tab will fall back to the GPX path for them (legacy behaviour).
-- ---------------------------------------------------------------------------
UPDATE trails t
SET simplified_path  = b.encoded,
    path_geojson     = b.geojson,
    path_point_count = b.point_count
FROM (
  SELECT tt.id, p.encoded, p.geojson, p.point_count
  FROM trails tt
  CROSS JOIN LATERAL trailforge_extract_lat_lng(tt.gpx_data::text) AS x
  CROSS JOIN LATERAL trailforge_build_path(x.lats, x.lngs)         AS p
  WHERE tt.gpx_data IS NOT NULL
    AND tt.simplified_path IS NULL
) b
WHERE t.id = b.id;
