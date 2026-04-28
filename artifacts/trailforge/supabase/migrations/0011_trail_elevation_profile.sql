-- TrailForge — pre-computed elevation profile columns on trails so the Map
-- tab and trail detail sheet can render an elevation chart and accurate
-- climb / descent stats without parsing GPX XML on the device.
--
-- Apply via the Supabase SQL editor after 0010_group_notifications.sql.
--
-- Mirrors the pattern in 0008_trail_simplified_path.sql:
--   * One BEFORE INSERT/UPDATE trigger on `gpx_data` derives the columns
--   * A LATERAL backfill at the bottom populates the columns for trails
--     that already exist
--
-- New columns:
--   * elevation_profile  jsonb  — downsampled array of integer elevations
--                                 (metres, rounded). Aligned with the
--                                 `simplified_path` polyline added in 0008
--                                 so a chart can be drawn straight against
--                                 distance position. NULL when the source
--                                 GPX has no <ele> data (or fewer than two
--                                 elevation samples).
--   * elevation_gain_m   int    — total ascent in metres (sum of positive
--                                 deltas, with a small smoothing threshold
--                                 to filter GPS jitter).
--   * elevation_loss_m   int    — total descent in metres (positive number,
--                                 sum of |negative deltas|).

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS elevation_profile jsonb,
  ADD COLUMN IF NOT EXISTS elevation_gain_m  integer,
  ADD COLUMN IF NOT EXISTS elevation_loss_m  integer;

-- ---------------------------------------------------------------------------
-- Helper: extract a parallel array of <ele> values for the GPX's track /
-- route points, in document order. Returns one row whose `eles` array has
-- one entry per <trkpt>/<rtept>; entries are NULL when the point is missing
-- an `<ele>` child (some GPX exporters omit elevation).
--
-- We use PostgreSQL's "advanced" regex flavour (the (?s) flag enables
-- single-line mode so `.` matches newlines too) so a single regexp_matches
-- pass captures both self-closing and body-bearing point elements.
--
-- IMPORTANT regex notes for PostgreSQL ARE:
--   * Any sub-expression that contains `|` is treated as "always greedy",
--     and that greediness propagates to the whole pattern — even with
--     `*?` quantifiers and a `\1` backreference, a `(.*?)` between two
--     `(trkpt|rtept)` alternations expands to the LAST closing tag in
--     the document, yielding a single giant match per GPX. To dodge this
--     we use two single-tag passes (no `|` anywhere) — one for `<trkpt>`
--     blocks, one for `<rtept>` blocks. GPX files in the wild use one or
--     the other consistently within a track/route, never both, so the
--     two passes never overlap.
--   * We only match body-bearing point elements. `<ele>` cannot live
--     inside a self-closing `<trkpt .../>` anyway, so dropping
--     self-closing points from the elevation array is lossless (they
--     wouldn't have contributed an elevation sample either way).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trailforge_extract_elevations(gpx text)
RETURNS TABLE (eles double precision[]) AS $$
DECLARE
  out_eles double precision[] := ARRAY[]::double precision[];
  rec      record;
  body     text;
  ele_txt  text;
  ele_val  double precision;
  any_ele  boolean := false;
  pattern  text;
  tag      text;
BEGIN
  IF gpx IS NULL THEN
    RETURN;
  END IF;

  FOREACH tag IN ARRAY ARRAY['trkpt', 'rtept'] LOOP
    pattern := '(?s)<' || tag
            || '\s[^>]*?lat="[^"]+?"[^>]*?lon="[^"]+?"[^>]*?>(.*?)</'
            || tag || '>';
    FOR rec IN
      SELECT regexp_matches(gpx, pattern, 'g') AS m
    LOOP
      body := rec.m[1];
      IF body IS NULL THEN
        out_eles := array_append(out_eles, NULL::double precision);
        CONTINUE;
      END IF;
      ele_txt := (regexp_match(body, '<ele>\s*([-0-9.eE+]+)\s*</ele>'))[1];
      IF ele_txt IS NULL THEN
        out_eles := array_append(out_eles, NULL::double precision);
      ELSE
        BEGIN
          ele_val := ele_txt::double precision;
          out_eles := array_append(out_eles, ele_val);
          any_ele := true;
        EXCEPTION WHEN OTHERS THEN
          out_eles := array_append(out_eles, NULL::double precision);
        END;
      END IF;
    END LOOP;
    -- If this tag yielded any matches, don't run the other tag's pass —
    -- mixed trkpt+rtept files don't exist in practice, and concatenating
    -- the two passes would put rtept points after all trkpt points
    -- regardless of document order.
    IF array_length(out_eles, 1) IS NOT NULL THEN
      EXIT;
    END IF;
  END LOOP;

  IF NOT any_ele OR array_length(out_eles, 1) IS NULL THEN
    RETURN;
  END IF;

  eles := out_eles;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ---------------------------------------------------------------------------
-- Helper: build the downsampled elevation profile + ascent/descent totals
-- from a full elevations array. Mirrors the stride-sampling used by
-- `trailforge_build_path` in migration 0008 so the resulting profile lines
-- up index-for-index with `simplified_path` (when both arrays are produced
-- from the same GPX).
--
-- Gain / loss are computed from the FULL elevation array (not the
-- downsampled one) with a small `jitter_m` threshold so flat sections
-- don't accumulate spurious metres from GPS noise.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trailforge_build_elevation(
  eles double precision[],
  max_points int   DEFAULT 1500,
  jitter_m   double precision DEFAULT 1.0
)
RETURNS TABLE (
  profile jsonb,
  gain_m  int,
  loss_m  int
) AS $$
DECLARE
  n            int;
  stride       int;
  i            int;
  prev_e       double precision;
  cur_e        double precision;
  delta        double precision;
  ascent       double precision := 0;
  descent      double precision := 0;
  chosen       int[] := ARRAY[]::int[];
  pc           int;
BEGIN
  IF eles IS NULL OR array_length(eles, 1) IS NULL OR array_length(eles, 1) < 2 THEN
    RETURN;
  END IF;

  n := array_length(eles, 1);

  -- Compute ascent / descent over the full array (skipping NULL samples).
  prev_e := NULL;
  FOR i IN 1..n LOOP
    cur_e := eles[i];
    IF cur_e IS NULL THEN
      CONTINUE;
    END IF;
    IF prev_e IS NOT NULL THEN
      delta := cur_e - prev_e;
      IF delta > jitter_m THEN
        ascent := ascent + delta;
      ELSIF delta < -jitter_m THEN
        descent := descent + (-delta);
      END IF;
    END IF;
    prev_e := cur_e;
  END LOOP;

  -- Downsample to <= max_points, keeping the last point so endpoints stay
  -- accurate. Missing samples are emitted as JSON `null`.
  stride := GREATEST(1, ceil(n::numeric / GREATEST(max_points, 2))::int);
  i := 1;
  WHILE i <= n LOOP
    chosen := array_append(chosen, i);
    i := i + stride;
  END LOOP;
  IF chosen[array_upper(chosen, 1)] <> n THEN
    chosen := array_append(chosen, n);
  END IF;

  pc := array_length(chosen, 1);

  profile := (
    SELECT jsonb_agg(
      CASE
        WHEN eles[chosen[s.i]] IS NULL THEN 'null'::jsonb
        ELSE to_jsonb(round(eles[chosen[s.i]])::int)
      END
      ORDER BY s.i
    )
    FROM generate_series(1, pc) AS s(i)
  );
  gain_m := round(ascent)::int;
  loss_m := round(descent)::int;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Trigger: keep the elevation columns in sync with gpx_data. Runs alongside
-- `trails_simplified_path_trigger` (migration 0008) on the same column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trails_set_elevation_profile() RETURNS trigger AS $$
DECLARE
  ex    record;
  built record;
BEGIN
  IF NEW.gpx_data IS NULL THEN
    NEW.elevation_profile := NULL;
    NEW.elevation_gain_m  := NULL;
    NEW.elevation_loss_m  := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO ex FROM trailforge_extract_elevations(NEW.gpx_data::text);
  IF ex IS NULL OR ex.eles IS NULL THEN
    NEW.elevation_profile := NULL;
    NEW.elevation_gain_m  := NULL;
    NEW.elevation_loss_m  := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO built FROM trailforge_build_elevation(ex.eles);
  IF built IS NULL OR built.profile IS NULL THEN
    NEW.elevation_profile := NULL;
    NEW.elevation_gain_m  := NULL;
    NEW.elevation_loss_m  := NULL;
  ELSE
    NEW.elevation_profile := built.profile;
    NEW.elevation_gain_m  := built.gain_m;
    NEW.elevation_loss_m  := built.loss_m;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trails_elevation_profile_trigger ON trails;
CREATE TRIGGER trails_elevation_profile_trigger
  BEFORE INSERT OR UPDATE OF gpx_data ON trails
  FOR EACH ROW EXECUTE FUNCTION trails_set_elevation_profile();

-- ---------------------------------------------------------------------------
-- Backfill: populate the new columns for every existing trail whose GPX
-- contains usable <ele> data. Trails without elevation (or with NULL
-- gpx_data) are left with NULL elevation columns and the UI will simply
-- omit the chart for them.
-- ---------------------------------------------------------------------------
UPDATE trails t
SET elevation_profile = b.profile,
    elevation_gain_m  = b.gain_m,
    elevation_loss_m  = b.loss_m
FROM (
  SELECT tt.id, p.profile, p.gain_m, p.loss_m
  FROM trails tt
  CROSS JOIN LATERAL trailforge_extract_elevations(tt.gpx_data::text) AS x
  CROSS JOIN LATERAL trailforge_build_elevation(x.eles)               AS p
  WHERE tt.gpx_data IS NOT NULL
    AND tt.elevation_profile IS NULL
) b
WHERE t.id = b.id;
