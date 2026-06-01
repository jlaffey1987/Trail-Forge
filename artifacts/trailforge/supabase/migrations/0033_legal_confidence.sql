-- TrailForge — Legal confidence system + system_config table + OSM way IDs.
--
-- The legal_confidence field classifies how reliably a trail's access status
-- is known so the UI can show appropriate confidence indicators to riders.

-- ── trails table extensions ──────────────────────────────────────────────────

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS legal_confidence text DEFAULT 'unverified'
    CHECK (legal_confidence IN ('verified', 'osm_legal', 'user_submitted', 'unverified', 'flagged', 'rejected'));

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS legal_source text;

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS legal_verified_at timestamptz;

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS legal_notes text;

-- Array of OSM way IDs for deduplication during OSM imports.
ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS osm_way_ids text[];

-- Backfill: existing TET-UK and ACT imported rows get osm_legal where their
-- legal_status already implies confirmed access.
UPDATE trails
SET legal_confidence = 'osm_legal'
WHERE legal_confidence = 'unverified'
  AND legal_status IN ('BOAT', 'legal', 'permissive');

-- Index for fast lookup during OSM sync deduplication.
CREATE INDEX IF NOT EXISTS trails_osm_way_ids_gin
  ON trails USING gin(osm_way_ids);

-- ── system_config ─────────────────────────────────────────────────────────────
-- Key-value store for server-managed configuration (last sync dates, etc).

CREATE TABLE IF NOT EXISTS system_config (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz DEFAULT now()
);

-- Seed the OSM sync start date so the first sync fetches recent changes only.
INSERT INTO system_config (key, value, updated_at)
VALUES ('osm_last_sync', (now() - INTERVAL '7 days')::text, now())
ON CONFLICT (key) DO NOTHING;
