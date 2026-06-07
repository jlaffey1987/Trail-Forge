-- Store full-route overview polyline for featured collections (e.g. TNT master line).
ALTER TABLE trail_collections
  ADD COLUMN IF NOT EXISTS overview_path_geojson jsonb;
